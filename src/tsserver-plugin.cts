import TS from 'typescript';
import type * as TSServer from 'typescript/lib/tsserverlibrary';

const path = require('node:path') as typeof import('node:path');

type TSModule = typeof import('typescript');
type PluginCreateInfo = TSServer.server.PluginCreateInfo;
type LanguageService = TSServer.LanguageService;
type DefinitionInfo = TS.DefinitionInfo;
type TextSpan = TS.TextSpan;
type CompilerOptions = TS.CompilerOptions;
type Declaration = TS.Declaration;
type SourceFile = TS.SourceFile;
type TypeChecker = TS.TypeChecker;
type TypeNode = TS.TypeNode;
type Type = TS.Type;
type Expression = TS.Expression;
type StringLiteralNode = TS.StringLiteral | TS.NoSubstitutionTemplateLiteral;
type PropertyNameNode = TS.PropertyName | TS.PrivateIdentifier | undefined;
type CallLikeExpression = TS.CallExpression | TS.NewExpression;
type PackageJson = { imports?: Record<string, unknown> };
type PluginSettings = {
    hideDeclaration: boolean;
    hideImports: boolean;
};
type PluginModuleFactory = (modules: { typescript: TSModule }) => {
    create: (info: PluginCreateInfo) => LanguageService;
    onConfigurationChanged?: (config: unknown) => void;
};

export type CustomDefinitionState = {
    mode?: 'literal' | 'reverse';
    textSpan?: TextSpan;
    definition?: DefinitionInfo;
    definitions?: DefinitionInfo[];
};

export type FindCustomDefinition = (ts: TSModule, program: TS.Program | undefined, fileName: string, position: number) => CustomDefinitionState;

const pluginFactory: PluginModuleFactory = init;

module.exports = pluginFactory;
module.exports.findCustomDefinition = findCustomDefinition;

function init({ typescript: ts }: { typescript: TSModule }): {
    create: (info: PluginCreateInfo) => LanguageService;
    onConfigurationChanged: (config: unknown) => void;
} {
    let pluginSettings: PluginSettings = defaultPluginSettings();

    function create(info: PluginCreateInfo): LanguageService {
        const languageService = info.languageService;
        const proxy = Object.create(null) as LanguageService;
        const languageServiceMap = languageService as unknown as Record<string, unknown>;
        const proxyMap = proxy as unknown as Record<string, unknown>;

        for (const key of Object.keys(languageServiceMap)) {
            const value = languageServiceMap[key];
            proxyMap[key] = typeof value === 'function' ? value.bind(languageService) : value;
        }

        proxy.getDefinitionAtPosition = (fileName: string, position: number) => {
            const settings = getPluginSettings(info, pluginSettings);
            const prior = languageService.getDefinitionAtPosition(fileName, position) ?? [];
            const custom = getCustomDefinitionState(ts, info, fileName, position);
            const customDefinitions = filterDefinitions(
                ts,
                info.languageService.getProgram(),
                custom.definitions ?? (custom.definition ? [custom.definition] : []),
                fileName,
                position,
                custom.textSpan,
                settings
            );
            if (customDefinitions.length === 0) {
                return filterDefinitions(ts, info.languageService.getProgram(), prior, fileName, position, undefined, settings);
            }

            if (custom.mode === 'literal') {
                return customDefinitions;
            }

            return mergeDefinitions(customDefinitions, filterDefinitions(ts, info.languageService.getProgram(), prior, fileName, position, custom.textSpan, settings));
        };

        proxy.getDefinitionAndBoundSpan = (fileName: string, position: number) => {
            const settings = getPluginSettings(info, pluginSettings);
            const prior = languageService.getDefinitionAndBoundSpan(fileName, position);
            const custom = getCustomDefinitionState(ts, info, fileName, position);
            const customDefinitions = filterDefinitions(
                ts,
                info.languageService.getProgram(),
                custom.definitions ?? (custom.definition ? [custom.definition] : []),
                fileName,
                position,
                custom.textSpan,
                settings
            );
            if (customDefinitions.length === 0 || !custom.textSpan) {
                if (!prior) {
                    return prior;
                }

                return {
                    textSpan: prior.textSpan,
                    definitions: filterDefinitions(ts, info.languageService.getProgram(), prior.definitions ?? [], fileName, position, undefined, settings),
                };
            }

            if (custom.mode === 'literal') {
                return {
                    textSpan: custom.textSpan,
                    definitions: customDefinitions,
                };
            }

            return {
                textSpan: custom.textSpan,
                definitions: mergeDefinitions(
                    customDefinitions,
                    filterDefinitions(ts, info.languageService.getProgram(), prior?.definitions ?? [], fileName, position, custom.textSpan, settings)
                ),
            };
        };

        return proxy;
    }

    function onConfigurationChanged(config: unknown): void {
        pluginSettings = readPluginSettings(config);
    }

    return { create, onConfigurationChanged };
}

function getCustomDefinitionState(ts: TSModule, info: PluginCreateInfo, fileName: string, position: number): CustomDefinitionState {
    const program = info.languageService.getProgram();
    return findCustomDefinition(ts, program, fileName, position);
}

function findCustomDefinition(ts: TSModule, program: TS.Program | undefined, fileName: string, position: number): CustomDefinitionState {
    if (!program) {
        return {};
    }

    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) {
        return {};
    }

    for (const candidatePosition of getNearbyOffsets(sourceFile, position)) {
        const state = findCustomDefinitionAtOffset(ts, program, sourceFile, candidatePosition);
        if ((state.definitions?.length ?? 0) > 0 || state.definition) {
            return state;
        }
    }

    return {};
}

function findCustomDefinitionAtOffset(ts: TSModule, program: TS.Program, sourceFile: SourceFile, position: number): CustomDefinitionState {
    const fileName = sourceFile.fileName;

    const node = findNodeAtOffset(ts, sourceFile, position);
    if (!node) {
        return {};
    }

    const checker = program.getTypeChecker();
    if (isStringLiteralNode(ts, node)) {
        const target = resolveLiteralTarget(ts, checker, program.getCompilerOptions(), node);
        if (target) {
            const definition = definitionInfoForDeclaration(ts, target);
            return {
                mode: 'literal',
                textSpan: createTextSpan(ts, node.getStart(sourceFile), node.getEnd() - node.getStart(sourceFile)),
                definition,
                definitions: [definition],
            };
        }
    }

    const declaration = resolveReverseDefinitionTarget(ts, checker, node);
    if (!declaration) {
        return {};
    }

    const definitions = findReverseDefinitions(ts, checker, program, declaration);
    if (definitions.length === 0) {
        return {};
    }

    const targetNode = getDefinitionTargetNode(declaration);
    return {
        mode: 'reverse',
        textSpan: createTextSpan(ts, targetNode.getStart(sourceFile), targetNode.getWidth(sourceFile)),
        definition: definitions[0],
        definitions,
    };
}

function findReverseDefinitions(ts: TSModule, checker: TypeChecker, program: TS.Program, declaration: Declaration): DefinitionInfo[] {
    const compilerOptions = program.getCompilerOptions();
    const reverseDefinitions: DefinitionInfo[] = [];
    const declarationTargetNode = getDefinitionTargetNode(declaration);

    for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile || sourceFile.fileName.includes(`${path.sep}node_modules${path.sep}`)) {
            continue;
        }

        const visit = (node: TS.Node): void => {
            if (isStringLiteralNode(ts, node)) {
                const target = resolveLiteralTarget(ts, checker, compilerOptions, node);
                if (target && declarationsMatch(target, declaration)) {
                    reverseDefinitions.push(definitionInfoForNode(ts, node));
                }
            } else if (ts.isPropertyAccessExpression(node)) {
                const target = resolveSelectedDeclaration(ts, checker, node.name);
                if (target && declarationsMatch(target, declaration) && !isSameTargetNode(node.name, declarationTargetNode)) {
                    reverseDefinitions.push(definitionInfoForNode(ts, node.name));
                }
            } else if (isReverseReferenceNode(ts, node)) {
                const target = resolveSelectedDeclaration(ts, checker, node);
                if (target && declarationsMatch(target, declaration) && !isSameTargetNode(node, declarationTargetNode)) {
                    reverseDefinitions.push(definitionInfoForNode(ts, node));
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
    }

    return mergeDefinitions(reverseDefinitions, []);
}

function resolveReverseDefinitionTarget(ts: TSModule, checker: TypeChecker, node: TS.Node): Declaration | undefined {
    const declaration = resolveSelectedDeclaration(ts, checker, node);
    if (!declaration) {
        return undefined;
    }

    if (shouldSkipReverseDefinitionDeclaration(ts, declaration)) {
        return undefined;
    }

    const targetNode = getDefinitionTargetNode(declaration);
    return isSameTargetNode(node, targetNode) ? declaration : undefined;
}

function shouldSkipReverseDefinitionDeclaration(ts: TSModule, declaration: Declaration): boolean {
    if (ts.isParameter(declaration)) {
        return true;
    }

    if (ts.isVariableDeclaration(declaration)) {
        const declarationList = declaration.parent;
        return ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const) !== 0;
    }

    return false;
}

function resolveSelectedDeclaration(ts: TSModule, checker: TypeChecker, node: TS.Node): Declaration | undefined {
    for (let current: TS.Node | undefined = node; current; current = current.parent) {
        const namedDeclaration = resolveNamedDeclarationAtNode(ts, current);
        if (namedDeclaration) {
            return namedDeclaration;
        }

        const symbol = resolveAliasedSymbol(ts, checker, checker.getSymbolAtLocation(current) ?? undefined);
        const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        if (declaration) {
            return declaration;
        }
    }

    return undefined;
}

function resolveNamedDeclarationAtNode(ts: TSModule, node: TS.Node): Declaration | undefined {
    const parent = node.parent as (Declaration & { name?: TS.Node }) | undefined;
    if (!parent || parent.name !== node || !isNamedDeclarationParent(ts, parent)) {
        return undefined;
    }

    return parent;
}

function isNamedDeclarationParent(ts: TSModule, node: TS.Node): node is Declaration & { name: TS.Node } {
    return (
        ts.isBindingElement(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isEnumMember(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isPropertyAssignment(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isTypeParameterDeclaration(node) ||
        ts.isVariableDeclaration(node)
    );
}

function declarationsMatch(left: Declaration, right: Declaration): boolean {
    if (left === right) {
        return true;
    }

    return left.getSourceFile().fileName === right.getSourceFile().fileName && left.getStart() === right.getStart() && left.getEnd() === right.getEnd();
}

function mergeDefinitions(customDefinitions: readonly DefinitionInfo[], existingDefinitions: readonly DefinitionInfo[]): DefinitionInfo[] {
    const merged = [...customDefinitions, ...existingDefinitions];
    const seen = new Set<string>();
    return merged.filter((definition) => {
        const key = `${definition.fileName}:${definition.textSpan.start}:${definition.textSpan.length}`;
        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

function defaultPluginSettings(): PluginSettings {
    return {
        hideDeclaration: true,
        hideImports: true,
    };
}

function getPluginSettings(info: PluginCreateInfo, configuredSettings: PluginSettings): PluginSettings {
    const infoConfig = info.config;
    if (!infoConfig || (typeof infoConfig === 'object' && Object.keys(infoConfig as Record<string, unknown>).length === 0)) {
        return configuredSettings;
    }

    return readPluginSettings(infoConfig);
}

function readPluginSettings(configValue: unknown): PluginSettings {
    const config = (configValue ?? {}) as Record<string, unknown>;
    return {
        hideDeclaration: getBooleanConfig(config, 'hideDeclaration', getBooleanConfig(config, 'hide-declaration', true)),
        hideImports: getBooleanConfig(config, 'hideImports', getBooleanConfig(config, 'hide-imports', true)),
    };
}

function getBooleanConfig(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
    const value = config[key];
    return typeof value === 'boolean' ? value : fallback;
}

function filterDefinitions(
    ts: TSModule,
    program: TS.Program | undefined,
    definitions: readonly DefinitionInfo[],
    fileName: string,
    position: number,
    textSpan: TextSpan | undefined,
    settings: PluginSettings
): DefinitionInfo[] {
    let nextDefinitions = [...definitions];

    if (settings.hideDeclaration) {
        nextDefinitions = filterReverseSelfDefinition(ts, program, nextDefinitions, fileName, position, textSpan);
    }

    if (settings.hideImports) {
        nextDefinitions = nextDefinitions.filter((definition) => !isImportDefinition(ts, program, definition));
    }

    return nextDefinitions;
}

function filterReverseSelfDefinition(
    ts: TSModule,
    program: TS.Program | undefined,
    definitions: readonly DefinitionInfo[],
    fileName: string,
    position: number,
    textSpan: TextSpan | undefined
): DefinitionInfo[] {
    const selfDeclaration = resolveSelfDeclarationAtPosition(ts, program, fileName, position);
    if (selfDeclaration) {
        const targetNode = getDefinitionTargetNode(selfDeclaration);
        const targetStart = targetNode.getStart();
        const targetEnd = targetNode.getEnd();

        return definitions.filter((definition) => {
            if (definition.fileName !== selfDeclaration.getSourceFile().fileName) {
                return true;
            }

            const definitionStart = definition.textSpan.start;
            const definitionEnd = definition.textSpan.start + definition.textSpan.length;
            return definitionEnd <= targetStart || definitionStart >= targetEnd;
        });
    }

    if (!textSpan) {
        return [...definitions];
    }

    return definitions.filter(
        (definition) => !(definition.fileName === fileName && definition.textSpan.start === textSpan.start && definition.textSpan.length === textSpan.length)
    );
}

function resolveSelfDeclarationAtPosition(ts: TSModule, program: TS.Program | undefined, fileName: string, position: number): Declaration | undefined {
    if (!program) {
        return undefined;
    }

    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) {
        return undefined;
    }

    const checker = program.getTypeChecker();
    for (const candidatePosition of getNearbyOffsets(sourceFile, position)) {
        const node = findNodeAtOffset(ts, sourceFile, candidatePosition);
        if (!node) {
            continue;
        }

        const declaration = resolveReverseDefinitionTarget(ts, checker, node);
        if (declaration) {
            return declaration;
        }
    }

    return undefined;
}

function getNearbyOffsets(sourceFile: SourceFile, position: number): number[] {
    const maxOffset = sourceFile.getEnd();
    const candidates = [position, position - 1, position + 1];
    const seen = new Set<number>();
    const offsets: number[] = [];

    for (const candidate of candidates) {
        if (candidate < 0 || candidate >= maxOffset || seen.has(candidate)) {
            continue;
        }

        seen.add(candidate);
        offsets.push(candidate);
    }

    return offsets;
}

function isImportDefinition(ts: TSModule, program: TS.Program | undefined, definition: DefinitionInfo): boolean {
    const sourceFile = program?.getSourceFile(definition.fileName);
    if (!sourceFile) {
        return false;
    }

    const node = findNodeAtOffset(ts, sourceFile, definition.textSpan.start);
    if (!node) {
        return false;
    }

    for (let current: TS.Node | undefined = node; current; current = current.parent) {
        if (
            ts.isImportDeclaration(current) ||
            ts.isImportClause(current) ||
            ts.isImportSpecifier(current) ||
            ts.isNamespaceImport(current) ||
            ts.isNamespaceExport(current) ||
            ts.isImportEqualsDeclaration(current)
        ) {
            return true;
        }
    }

    return false;
}

function createTextSpan(ts: TSModule, start: number, length: number): TextSpan {
    return typeof ts.createTextSpan === 'function' ? ts.createTextSpan(start, length) : { start, length };
}

function definitionInfoForDeclaration(ts: TSModule, declaration: Declaration): DefinitionInfo {
    const targetNode = getDefinitionTargetNode(declaration);
    return definitionInfoForNode(ts, targetNode);
}

function definitionInfoForNode(ts: TSModule, node: TS.Node): DefinitionInfo {
    const sourceFile = node.getSourceFile();
    return {
        fileName: sourceFile.fileName,
        textSpan: createTextSpan(ts, node.getStart(sourceFile), node.getWidth(sourceFile)),
        kind: ts.ScriptElementKind.unknown,
        name: node.getText(sourceFile),
        containerKind: ts.ScriptElementKind.unknown,
        containerName: '',
    };
}

function getDefinitionTargetNode(declaration: Declaration): TS.Node {
    const namedDeclaration = declaration as Declaration & { name?: TS.Node };
    return namedDeclaration.name ?? declaration;
}

function isReverseReferenceNode(ts: TSModule, node: TS.Node): node is TS.Identifier | TS.PrivateIdentifier {
    return ts.isIdentifier(node) || ts.isPrivateIdentifier(node);
}

function isSameTargetNode(left: TS.Node, right: TS.Node): boolean {
    return (
        left.getSourceFile().fileName === right.getSourceFile().fileName &&
        left.getStart(left.getSourceFile()) === right.getStart(right.getSourceFile()) &&
        left.getEnd() === right.getEnd()
    );
}

function findNodeAtOffset(ts: TSModule, sourceFile: SourceFile, offset: number): TS.Node | undefined {
    let current: TS.Node | undefined;

    const visit = (node: TS.Node): void => {
        if (offset < node.getFullStart() || offset >= node.getEnd()) {
            return;
        }

        current = node;
        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return current;
}

function isStringLiteralNode(ts: TSModule, node: TS.Node): node is StringLiteralNode {
    return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function resolveLiteralTarget(ts: TSModule, checker: TypeChecker, compilerOptions: CompilerOptions, node: StringLiteralNode): Declaration | undefined {
    return (
        resolveCallArgumentTarget(ts, checker, compilerOptions, node) ??
        resolveTupleElementTarget(ts, checker, compilerOptions, node) ??
        resolveTypedInitializerTarget(ts, checker, node) ??
        resolveContextualAliasTarget(checker, node)
    );
}

function resolveCallArgumentTarget(ts: TSModule, checker: TypeChecker, compilerOptions: CompilerOptions, node: StringLiteralNode): Declaration | undefined {
    const parent = node.parent;
    if (!parent || (!ts.isCallExpression(parent) && !ts.isNewExpression(parent))) {
        return undefined;
    }

    const argumentIndex = parent.arguments?.findIndex((argument) => argument === node) ?? -1;
    if (argumentIndex < 0) {
        return undefined;
    }

    const structuralPropertyTarget = resolvePropertyTargetFromCallContext(ts, checker, parent, argumentIndex, node.text);
    if (structuralPropertyTarget) {
        return structuralPropertyTarget;
    }

    const signature = checker.getResolvedSignature(parent);
    if (!signature) {
        return undefined;
    }

    const parameters = signature.getParameters();
    if (parameters.length === 0) {
        return undefined;
    }

    const parameter = parameters[Math.min(argumentIndex, parameters.length - 1)];
    const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
    if (!declaration || !ts.isParameter(declaration) || !declaration.type) {
        return undefined;
    }

    const keyofTarget = resolveKeyofParameterTarget(ts, checker, node, parent, declaration.type);
    if (keyofTarget) {
        return keyofTarget;
    }

    const propertyKeyTarget = resolvePropertyKeyTargetFromTypeNode(ts, checker, declaration.type, node.text);
    if (propertyKeyTarget) {
        return propertyKeyTarget;
    }

    const parameterType = checker.getTypeAtLocation(declaration.type);
    if (!typeIncludesLiteral(ts, parameterType, node.text)) {
        return undefined;
    }

    return declarationForTypeNode(ts, checker, declaration.type);
}

function resolvePropertyTargetFromCallContext(
    ts: TSModule,
    checker: TypeChecker,
    callExpression: CallLikeExpression,
    argumentIndex: number,
    propertyName: string
): Declaration | undefined {
    if (!ts.isCallExpression(callExpression) || !ts.isPropertyAccessExpression(callExpression.expression)) {
        return undefined;
    }

    if (argumentIndex === 0 && unwrapQueryBuilderBaseExpression(ts, callExpression.expression.expression)) {
        const queryBuilderClassTarget = resolvePropertyTargetFromQueryBuilderBase(ts, checker, callExpression.expression.expression, propertyName);
        if (queryBuilderClassTarget) {
            return queryBuilderClassTarget;
        }

        const queryBuilderTarget = resolvePropertyTargetFromQueryBuilderReceiver(checker, callExpression.expression.expression, propertyName);
        if (queryBuilderTarget) {
            return queryBuilderTarget;
        }
    }

    const methodType = checker.getTypeAtLocation(callExpression.expression);
    for (const signature of methodType.getCallSignatures()) {
        const parameters = signature.getParameters();
        if (parameters.length === 0) {
            continue;
        }

        const signatureDeclaration = signature.getDeclaration();
        const receiverTarget = resolvePropertyTargetFromCallReceiver(checker, callExpression.expression.expression, propertyName);
        if (receiverTarget && signatureDeclaration && !signatureDeclaration.getSourceFile().fileName.includes(`${path.sep}node_modules${path.sep}`)) {
            return receiverTarget;
        }

        const parameter = parameters[Math.min(argumentIndex, parameters.length - 1)];
        const parameterType = checker.getTypeOfSymbolAtLocation(parameter, callExpression.expression);
        if (!typeIncludesLiteral(ts, parameterType, propertyName)) {
            continue;
        }

        if (receiverTarget) {
            return receiverTarget;
        }
    }

    return undefined;
}

function resolvePropertyTargetFromQueryBuilderReceiver(checker: TypeChecker, receiverExpression: Expression, propertyName: string): Declaration | undefined {
    const receiverType = checker.getTypeAtLocation(receiverExpression) as Type & { aliasSymbol?: TS.Symbol; types?: Type[] };
    const typeStrings = [checker.typeToString(receiverType)];

    if (receiverType.aliasSymbol?.name) {
        typeStrings.push(receiverType.aliasSymbol.name);
    }

    if (Array.isArray(receiverType.types)) {
        for (const member of receiverType.types) {
            typeStrings.push(checker.typeToString(member));
        }
    }

    if (!typeStrings.some((value) => value.includes('ModelQueryBuilderContract') || value.includes('TypedModelQueryBuilderContract'))) {
        return undefined;
    }

    return resolvePropertyTargetFromCallReceiver(checker, receiverExpression, propertyName);
}

function resolvePropertyTargetFromQueryBuilderBase(ts: TSModule, checker: TypeChecker, receiverExpression: Expression, propertyName: string): Declaration | undefined {
    const baseExpression = unwrapQueryBuilderBaseExpression(ts, receiverExpression);
    if (!baseExpression) {
        return undefined;
    }

    const symbol = resolveExpressionSymbol(ts, checker, baseExpression);
    if (!symbol) {
        return undefined;
    }

    for (const declaration of symbol.declarations ?? []) {
        if (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) {
            continue;
        }

        for (const member of declaration.members) {
            if (hasStaticModifier(ts, member)) {
                continue;
            }

            if (getPropertyNameText(ts, member.name) === propertyName) {
                return member;
            }
        }
    }

    return undefined;
}

function unwrapQueryBuilderBaseExpression(ts: TSModule, expression: Expression): Expression | undefined {
    const target = skipOuterExpressions(ts, expression);
    if (!ts.isCallExpression(target)) {
        return undefined;
    }

    const callee = skipOuterExpressions(ts, target.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'query') {
        return callee.expression;
    }

    if (ts.isPropertyAccessExpression(callee)) {
        return unwrapQueryBuilderBaseExpression(ts, callee.expression);
    }

    return undefined;
}

function resolvePropertyTargetFromCallReceiver(checker: TypeChecker, receiverExpression: Expression, propertyName: string): Declaration | undefined {
    const receiverType = checker.getTypeAtLocation(receiverExpression) as Type & { aliasTypeArguments?: Type[]; types?: Type[] };
    const candidateTypes: Type[] = [];

    if (Array.isArray(receiverType.aliasTypeArguments)) {
        candidateTypes.push(...receiverType.aliasTypeArguments);
    }

    if (Array.isArray(receiverType.types)) {
        for (const member of receiverType.types) {
            const typedMember = member as Type & { aliasTypeArguments?: Type[] };
            if (Array.isArray(typedMember.aliasTypeArguments)) {
                candidateTypes.push(...typedMember.aliasTypeArguments);
            }
        }
    }

    for (let index = candidateTypes.length - 1; index >= 0; index -= 1) {
        const target = resolvePropertyTargetFromType(checker, candidateTypes[index], propertyName);
        if (target) {
            return target;
        }
    }

    return undefined;
}

function resolveTupleElementTarget(ts: TSModule, checker: TypeChecker, compilerOptions: CompilerOptions, node: StringLiteralNode): Declaration | undefined {
    const arrayLiteral = node.parent;
    if (!arrayLiteral || !ts.isArrayLiteralExpression(arrayLiteral)) {
        return undefined;
    }

    const elementIndex = arrayLiteral.elements.findIndex((element) => element === node);
    if (elementIndex <= 0) {
        return undefined;
    }

    const firstElement = arrayLiteral.elements[0];
    if (!firstElement) {
        return undefined;
    }

    const memberOwnerType = resolveMemberOwnerType(checker, firstElement);
    if (memberOwnerType) {
        const typeTarget = resolvePropertyTargetFromType(checker, memberOwnerType, node.text);
        if (typeTarget) {
            return typeTarget;
        }
    }

    const lazyImportTarget = resolveTupleElementLazyImportMemberTarget(ts, checker, compilerOptions, firstElement, node.text);
    if (lazyImportTarget) {
        return lazyImportTarget;
    }

    return resolveTupleElementClassMemberTarget(ts, checker, firstElement, node.text);
}

function resolveMemberOwnerType(checker: TypeChecker, expression: Expression): Type {
    const expressionType = checker.getTypeAtLocation(expression);
    const constructSignatures = expressionType.getConstructSignatures();
    if (constructSignatures.length > 0) {
        return checker.getReturnTypeOfSignature(constructSignatures[0]);
    }

    const lazyImportType = resolveLazyImportMemberOwnerType(checker, expressionType);
    if (lazyImportType) {
        return lazyImportType;
    }

    return expressionType;
}

function resolveLazyImportMemberOwnerType(checker: TypeChecker, expressionType: Type): Type | undefined {
    for (const signature of expressionType.getCallSignatures()) {
        const returnType = checker.getReturnTypeOfSignature(signature);
        const promisedType = unwrapPromiseLikeType(checker, returnType);
        if (!promisedType) {
            continue;
        }

        const defaultExport = checker.getPropertyOfType(checker.getApparentType(promisedType), 'default');
        if (!defaultExport) {
            continue;
        }

        const declaration = defaultExport.valueDeclaration ?? defaultExport.declarations?.[0];
        if (!declaration) {
            continue;
        }

        const defaultExportType = checker.getTypeOfSymbolAtLocation(defaultExport, declaration);
        const constructSignatures = defaultExportType.getConstructSignatures();
        if (constructSignatures.length > 0) {
            return checker.getReturnTypeOfSignature(constructSignatures[0]);
        }

        return defaultExportType;
    }

    return undefined;
}

function unwrapPromiseLikeType(checker: TypeChecker, type: Type): Type | undefined {
    const typeArguments = checker.getTypeArguments(type as TS.TypeReference);
    if (typeArguments.length > 0) {
        return typeArguments[0];
    }

    return undefined;
}

function resolvePropertyTargetFromType(checker: TypeChecker, type: Type, propertyName: string): Declaration | undefined {
    const property = checker.getPropertyOfType(checker.getApparentType(type), propertyName);
    if (!property) {
        return undefined;
    }

    return property.declarations?.[0];
}

function resolveTupleElementClassMemberTarget(ts: TSModule, checker: TypeChecker, expression: Expression, memberName: string): Declaration | undefined {
    const symbol = resolveExpressionSymbol(ts, checker, expression);
    if (!symbol) {
        return undefined;
    }

    for (const declaration of symbol.declarations ?? []) {
        if (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) {
            continue;
        }

        for (const member of declaration.members) {
            if (hasStaticModifier(ts, member)) {
                continue;
            }

            if (getPropertyNameText(ts, member.name) === memberName) {
                return member;
            }
        }
    }

    return undefined;
}

function resolveTupleElementLazyImportMemberTarget(
    ts: TSModule,
    checker: TypeChecker,
    compilerOptions: CompilerOptions,
    expression: Expression,
    memberName: string
): Declaration | undefined {
    const symbol = resolveExpressionSymbol(ts, checker, expression);
    if (!symbol) {
        return undefined;
    }

    for (const declaration of symbol.declarations ?? []) {
        if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
            continue;
        }

        const importSpecifier = extractLazyImportSpecifier(ts, declaration.initializer);
        if (!importSpecifier) {
            continue;
        }

        const target = resolveImportedControllerMemberTarget(ts, compilerOptions, importSpecifier, declaration.getSourceFile().fileName, memberName);
        if (target) {
            return target;
        }
    }

    return undefined;
}

function extractLazyImportSpecifier(ts: TSModule, expression: Expression): string | undefined {
    const target = skipOuterExpressions(ts, expression);
    if (!ts.isArrowFunction(target) && !ts.isFunctionExpression(target)) {
        return undefined;
    }

    const body = ts.isBlock(target.body) ? getReturnedExpression(ts, target.body) : target.body;
    if (!body) {
        return undefined;
    }

    const callExpression = skipOuterExpressions(ts, body);
    if (!ts.isCallExpression(callExpression) || callExpression.expression.kind !== ts.SyntaxKind.ImportKeyword) {
        return undefined;
    }

    const [argument] = callExpression.arguments;
    return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function getReturnedExpression(ts: TSModule, block: TS.Block): Expression | undefined {
    for (const statement of block.statements) {
        if (ts.isReturnStatement(statement) && statement.expression) {
            return statement.expression;
        }
    }

    return undefined;
}

function resolveImportedControllerMemberTarget(
    ts: TSModule,
    compilerOptions: CompilerOptions,
    importSpecifier: string,
    containingFile: string,
    memberName: string
): Declaration | undefined {
    const resolvedFileName = resolveImportSpecifierToSourceFile(ts, compilerOptions, importSpecifier, containingFile);
    if (!resolvedFileName) {
        return undefined;
    }

    const sourceText = ts.sys.readFile(resolvedFileName);
    if (!sourceText) {
        return undefined;
    }

    const sourceFile = ts.createSourceFile(resolvedFileName, sourceText, ts.ScriptTarget.Latest, true, scriptKindForFileName(ts, resolvedFileName));
    const controllerClass = findDefaultExportClassDeclaration(ts, sourceFile);
    if (!controllerClass) {
        return undefined;
    }

    for (const member of controllerClass.members) {
        if (hasStaticModifier(ts, member)) {
            continue;
        }

        if (getPropertyNameText(ts, member.name) === memberName) {
            return member;
        }
    }

    return undefined;
}

function resolveImportSpecifierToSourceFile(ts: TSModule, compilerOptions: CompilerOptions, importSpecifier: string, containingFile: string): string | undefined {
    const resolvedModule = ts.resolveModuleName(importSpecifier, containingFile, compilerOptions, ts.sys).resolvedModule;
    if (resolvedModule?.resolvedFileName) {
        const resolved = resolveSourceFileFallback(ts, resolvedModule.resolvedFileName);
        return resolved ?? resolvedModule.resolvedFileName;
    }

    if (importSpecifier.startsWith('.')) {
        return resolveSourceFileCandidate(ts, path.resolve(path.dirname(containingFile), importSpecifier));
    }

    if (importSpecifier.startsWith('#')) {
        return resolvePackageImportTarget(ts, importSpecifier, containingFile);
    }

    return undefined;
}

function resolvePackageImportTarget(ts: TSModule, importSpecifier: string, containingFile: string): string | undefined {
    const packageJsonPath = findNearestPackageJson(ts, path.dirname(containingFile));
    if (!packageJsonPath) {
        return undefined;
    }

    const packageDir = path.dirname(packageJsonPath);
    const packageJson = readPackageJson(ts, packageJsonPath);
    const imports = packageJson?.imports;
    if (!imports) {
        return undefined;
    }

    for (const [pattern, rawTarget] of Object.entries(imports)) {
        const target = resolveImportTargetPattern(pattern, rawTarget, importSpecifier);
        if (!target) {
            continue;
        }

        return resolveSourceFileCandidate(ts, path.resolve(packageDir, target));
    }

    return undefined;
}

function resolveImportTargetPattern(pattern: string, rawTarget: unknown, importSpecifier: string): string | undefined {
    const target = typeof rawTarget === 'string' ? rawTarget : undefined;
    if (!target) {
        return undefined;
    }

    const wildcardIndex = pattern.indexOf('*');
    if (wildcardIndex === -1) {
        return pattern === importSpecifier ? target : undefined;
    }

    const prefix = pattern.slice(0, wildcardIndex);
    const suffix = pattern.slice(wildcardIndex + 1);
    if (!importSpecifier.startsWith(prefix) || !importSpecifier.endsWith(suffix)) {
        return undefined;
    }

    const wildcardValue = importSpecifier.slice(prefix.length, importSpecifier.length - suffix.length);
    return target.replace('*', wildcardValue);
}

function resolveSourceFileCandidate(ts: TSModule, fileName: string): string | undefined {
    if (ts.sys.fileExists(fileName)) {
        return fileName;
    }

    const fallback = resolveSourceFileFallback(ts, fileName);
    if (fallback) {
        return fallback;
    }

    if (path.extname(fileName)) {
        return undefined;
    }

    for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']) {
        const directCandidate = `${fileName}${extension}`;
        if (ts.sys.fileExists(directCandidate)) {
            return directCandidate;
        }

        const directFallback = resolveSourceFileFallback(ts, directCandidate);
        if (directFallback) {
            return directFallback;
        }
    }

    for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']) {
        const indexCandidate = path.join(fileName, `index${extension}`);
        if (ts.sys.fileExists(indexCandidate)) {
            return indexCandidate;
        }
    }

    return undefined;
}

function findNearestPackageJson(ts: TSModule, startDir: string): string | undefined {
    let currentDir = startDir;

    while (true) {
        const candidate = path.join(currentDir, 'package.json');
        if (ts.sys.fileExists(candidate)) {
            return candidate;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            return undefined;
        }

        currentDir = parentDir;
    }
}

function readPackageJson(ts: TSModule, filePath: string): PackageJson | undefined {
    const content = ts.sys.readFile(filePath);
    if (!content) {
        return undefined;
    }

    try {
        return JSON.parse(content) as PackageJson;
    } catch {
        return undefined;
    }
}

function scriptKindForFileName(ts: TSModule, fileName: string): TS.ScriptKind {
    const extension = path.extname(fileName).toLowerCase();

    switch (extension) {
        case '.js':
        case '.cjs':
            return ts.ScriptKind.JS;
        case '.jsx':
            return ts.ScriptKind.JSX;
        case '.tsx':
            return ts.ScriptKind.TSX;
        case '.json':
            return ts.ScriptKind.JSON;
        default:
            return ts.ScriptKind.TS;
    }
}

function resolveSourceFileFallback(ts: TSModule, fileName: string): string | undefined {
    if (fileName.includes(`${path.sep}node_modules${path.sep}`)) {
        return undefined;
    }

    const extension = path.extname(fileName).toLowerCase();
    if (!['.js', '.mjs', '.cjs'].includes(extension)) {
        return undefined;
    }

    const baseName = fileName.slice(0, -extension.length);
    for (const sourceExtension of ['.ts', '.tsx', '.mts', '.cts']) {
        const candidate = `${baseName}${sourceExtension}`;
        if (ts.sys.fileExists(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

function findDefaultExportClassDeclaration(ts: TSModule, sourceFile: SourceFile): TS.ClassDeclaration | undefined {
    let defaultClass: TS.ClassDeclaration | undefined;

    const visit = (node: TS.Node): void => {
        if (defaultClass) {
            return;
        }

        if (ts.isClassDeclaration(node) && hasDefaultModifier(ts, node)) {
            defaultClass = node;
            return;
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return defaultClass;
}

function hasDefaultModifier(ts: TSModule, node: TS.Node): boolean {
    return ts.canHaveModifiers(node) ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false) : false;
}

function resolveExpressionSymbol(ts: TSModule, checker: TypeChecker, expression: Expression): TS.Symbol | undefined {
    const target = skipOuterExpressions(ts, expression);
    const expressionType = checker.getTypeAtLocation(target);
    const candidateSymbols = [checker.getSymbolAtLocation(target), expressionType.aliasSymbol, expressionType.getSymbol(), checker.getApparentType(expressionType).getSymbol()];

    for (const candidate of candidateSymbols) {
        const symbol = resolveAliasedSymbol(ts, checker, candidate);
        if (symbol?.declarations?.length) {
            return symbol;
        }
    }

    return undefined;
}

function resolveAliasedSymbol(ts: TSModule, checker: TypeChecker, symbol: TS.Symbol | undefined): TS.Symbol | undefined {
    if (!symbol) {
        return undefined;
    }

    return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function skipOuterExpressions(ts: TSModule, expression: Expression): Expression {
    let current = expression;

    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
        current = current.expression;
    }

    return current;
}

function hasStaticModifier(ts: TSModule, node: TS.Node): boolean {
    return ts.canHaveModifiers(node) ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false) : false;
}

function getPropertyNameText(ts: TSModule, name: PropertyNameNode): string | undefined {
    if (!name || ts.isPrivateIdentifier(name)) {
        return undefined;
    }

    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }

    return undefined;
}

function resolveKeyofParameterTarget(
    ts: TSModule,
    checker: TypeChecker,
    node: StringLiteralNode,
    callExpression: CallLikeExpression,
    parameterTypeNode: TypeNode
): Declaration | undefined {
    if (!ts.isTypeOperatorNode(parameterTypeNode) || parameterTypeNode.operator !== ts.SyntaxKind.KeyOfKeyword) {
        return undefined;
    }

    const operandType = resolveKeyofOperandType(ts, checker, parameterTypeNode.type, callExpression);
    if (!operandType) {
        return undefined;
    }

    const propertyTarget = resolvePropertyTargetFromType(checker, operandType, node.text);
    if (propertyTarget) {
        return propertyTarget;
    }

    return resolveObjectKeyTargetFromTypeNode(ts, checker, parameterTypeNode.type, node.text);
}

function resolvePropertyKeyTargetFromTypeNode(ts: TSModule, checker: TypeChecker, typeNode: TypeNode, propertyName: string): Declaration | undefined {
    if (ts.isTypeOperatorNode(typeNode) && typeNode.operator === ts.SyntaxKind.KeyOfKeyword) {
        return resolveObjectKeyTargetFromTypeNode(ts, checker, typeNode.type, propertyName);
    }

    if (ts.isTypeReferenceNode(typeNode)) {
        const symbol = resolveAliasedSymbol(ts, checker, checker.getSymbolAtLocation(typeNode.typeName) ?? undefined);
        for (const declaration of symbol?.declarations ?? []) {
            if (!ts.isTypeAliasDeclaration(declaration)) {
                continue;
            }

            const target = resolvePropertyKeyTargetFromTypeNode(ts, checker, declaration.type, propertyName);
            if (target) {
                return target;
            }
        }
    }

    return undefined;
}

function resolveObjectKeyTargetFromTypeNode(ts: TSModule, checker: TypeChecker, typeNode: TypeNode, propertyName: string): Declaration | undefined {
    if (ts.isTypeQueryNode(typeNode)) {
        return (
            resolveObjectKeyTargetFromExpression(ts, checker, typeNode.exprName, propertyName) ??
            resolvePropertyTargetFromType(checker, checker.getTypeAtLocation(typeNode.exprName), propertyName)
        );
    }

    const operandType = checker.getTypeAtLocation(typeNode);
    return resolvePropertyTargetFromType(checker, operandType, propertyName);
}

function resolveObjectKeyTargetFromExpression(ts: TSModule, checker: TypeChecker, exprName: TS.EntityName, propertyName: string): Declaration | undefined {
    const symbol = resolveAliasedSymbol(ts, checker, checker.getSymbolAtLocation(exprName) ?? undefined);
    if (!symbol) {
        return undefined;
    }

    for (const declaration of symbol.declarations ?? []) {
        if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
            continue;
        }

        const target = resolveObjectKeyTargetFromInitializer(ts, declaration.initializer, propertyName);
        if (target) {
            return target;
        }
    }

    return undefined;
}

function resolveObjectKeyTargetFromInitializer(ts: TSModule, initializer: Expression, propertyName: string): Declaration | undefined {
    const expression = skipOuterExpressions(ts, initializer);
    if (!ts.isObjectLiteralExpression(expression)) {
        return undefined;
    }

    for (const property of expression.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property) && !ts.isMethodDeclaration(property)) {
            continue;
        }

        if (getPropertyNameText(ts, property.name) === propertyName) {
            return property;
        }
    }

    return undefined;
}

function resolveKeyofOperandType(ts: TSModule, checker: TypeChecker, operandTypeNode: TypeNode, callExpression: CallLikeExpression): Type | undefined {
    const inferredType = resolveTypeParameterFromCallArguments(ts, checker, operandTypeNode, callExpression);
    if (inferredType) {
        return inferredType;
    }

    return checker.getTypeAtLocation(operandTypeNode);
}

function resolveTypeParameterFromCallArguments(ts: TSModule, checker: TypeChecker, typeNode: TypeNode, callExpression: CallLikeExpression): Type | undefined {
    if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
        return undefined;
    }

    const typeParameterName = typeNode.typeName.text;
    const signatureDeclaration = callExpression.expression && checker.getResolvedSignature(callExpression)?.declaration;
    if (!signatureDeclaration || !signatureDeclaration.parameters) {
        return undefined;
    }

    for (const [index, parameter] of signatureDeclaration.parameters.entries()) {
        if (!ts.isParameter(parameter)) {
            continue;
        }

        if (!parameter.type || !isDirectTypeParameterReference(ts, parameter.type, typeParameterName)) {
            continue;
        }

        const argument = callExpression.arguments?.[index];
        if (!argument) {
            continue;
        }

        return checker.getTypeAtLocation(argument);
    }

    return undefined;
}

function isDirectTypeParameterReference(ts: TSModule, typeNode: TypeNode, typeParameterName: string): boolean {
    return ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName) && typeNode.typeName.text === typeParameterName;
}

function resolveTypedInitializerTarget(ts: TSModule, checker: TypeChecker, node: StringLiteralNode): Declaration | undefined {
    const parent = node.parent;
    if (!parent) {
        return undefined;
    }

    if (ts.isVariableDeclaration(parent) && parent.initializer === node && parent.type) {
        const variableType = checker.getTypeAtLocation(parent.type);
        if (typeIncludesLiteral(ts, variableType, node.text)) {
            return declarationForTypeNode(ts, checker, parent.type);
        }
    }

    if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
        const objectLiteral = parent.parent;
        if (ts.isObjectLiteralExpression(objectLiteral) && ts.isVariableDeclaration(objectLiteral.parent) && objectLiteral.parent.type) {
            const contextualType = checker.getTypeAtLocation(objectLiteral.parent.type);
            if (typeIncludesLiteral(ts, contextualType, node.text)) {
                return declarationForTypeNode(ts, checker, objectLiteral.parent.type);
            }
        }
    }

    return undefined;
}

function resolveContextualAliasTarget(checker: TypeChecker, node: StringLiteralNode): Declaration | undefined {
    const contextualType = checker.getContextualType(node);
    if (!contextualType || !typeIncludesLiteralFromFlags(contextualType, node.text)) {
        return undefined;
    }

    return contextualType.aliasSymbol?.declarations?.[0];
}

function typeIncludesLiteral(ts: TSModule, type: Type, literalText: string): boolean {
    if (type.isUnion()) {
        return type.types.some((member) => typeIncludesLiteral(ts, member, literalText));
    }

    return (type.flags & ts.TypeFlags.StringLiteral) !== 0 && (type as TS.StringLiteralType).value === literalText;
}

function typeIncludesLiteralFromFlags(type: Type, literalText: string): boolean {
    if (type.isUnion()) {
        return type.types.some((member) => typeIncludesLiteralFromFlags(member, literalText));
    }

    return typeof (type as { value?: unknown }).value === 'string' && (type as { value?: string }).value === literalText;
}

function declarationForTypeNode(ts: TSModule, checker: TypeChecker, typeNode: TypeNode): Declaration | undefined {
    const symbol = symbolForTypeNode(ts, checker, typeNode);
    return symbol?.declarations?.[0];
}

function symbolForTypeNode(ts: TSModule, checker: TypeChecker, typeNode: TypeNode): TS.Symbol | undefined {
    if (ts.isTypeReferenceNode(typeNode)) {
        return checker.getSymbolAtLocation(typeNode.typeName) ?? undefined;
    }

    const type = checker.getTypeAtLocation(typeNode);
    return type.aliasSymbol ?? type.getSymbol();
}
