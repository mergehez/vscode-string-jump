/// <reference types="node" />
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');

const packageJson = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
    version: string;
};

function loadEnvFile(filePath: string): Record<string, string> {
    if (!fs.existsSync(filePath)) {
        return {};
    }

    const values: Record<string, string> = {};
    for (const rawLine of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const separatorIndex = line.indexOf('=');
        if (separatorIndex <= 0) {
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        let value = line.slice(separatorIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        values[key] = value;
    }

    return values;
}

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const env = loadEnvFile(path.join(projectRoot, '.env'));

const vsixFile = `string-jump-${packageJson.version}.vsix`;
const skipBuild = process.argv.includes('-s');
const skipE2E = process.argv.includes('--direct') || process.argv.includes('--no-e2e');
const runExtensionAutoTest = process.argv.includes('--e2e');
let testFileArg = process.argv.find((value) => value.startsWith('--test'))?.split('=')[1] || '';
testFileArg ||= process.env.STRING_JUMP_TEST_TARGET ?? env.STRING_JUMP_TEST_TARGET ?? '';

if (!testFileArg) {
    throw new Error('Missing test target. Set --test=... or STRING_JUMP_TEST_TARGET in .env.');
}

const [testFile, testFileLineRaw, testFileColumnRaw] = testFileArg.split(':');
const testFileLine = Math.max((parseInt(testFileLineRaw, 10) || 1) - 1, 0);
const testFileColumn = Math.max((parseInt(testFileColumnRaw, 10) || 1) - 1, 0);

const COMMAND_SERVER_URL = process.env.STRING_JUMP_COMMAND_SERVER_URL ?? env.STRING_JUMP_COMMAND_SERVER_URL ?? '';
const logFile = process.env.STRING_JUMP_TEST_LOG_FILE ?? env.STRING_JUMP_TEST_LOG_FILE ?? path.join(projectRoot, 'dist', 'logs.txt');

type BuiltPlugin = {
    findCustomDefinition?: (
        tsModule: typeof import('typescript'),
        program: import('typescript').Program | undefined,
        fileName: string,
        position: number
    ) => {
        definitions?: Array<{ fileName: string; name: string; textSpan: { start: number; length: number } }>;
        definition?: { fileName: string; name: string; textSpan: { start: number; length: number } };
    };
};

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeCommand(command: string, args: any[] = []) {
    if (!COMMAND_SERVER_URL) {
        throw new Error('Missing STRING_JUMP_COMMAND_SERVER_URL. Set it in .env before running the E2E harness.');
    }

    const response = await fetch(`${COMMAND_SERVER_URL}/execute`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ command, args }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Status: ${response.status}\nError response: ${errorText}`);
    }

    return response.text();
}

async function restartExtensionHost() {
    try {
        await executeCommand('workbench.action.restartExtensionHost');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Canceled: Canceled') && !message.includes('Status: 400')) {
            throw error;
        }
    }
}

function probeBuiltResolver(file: string, line: number, column: number) {
    const plugin = require('./dist/tsserver-plugin.cjs') as BuiltPlugin;
    const resolver = plugin.findCustomDefinition;
    if (!resolver) {
        throw new Error('Built plugin does not export findCustomDefinition');
    }

    const configPath = ts.findConfigFile(path.dirname(file), ts.sys.fileExists);
    let rootNames = [file];
    let options: import('typescript').CompilerOptions = {
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.Node16,
        moduleResolution: ts.ModuleResolutionKind.Node16,
        skipLibCheck: true,
    };

    if (configPath) {
        const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
        if (configFile.error) {
            throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
        }

        const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
        rootNames = parsedConfig.fileNames.includes(file) ? parsedConfig.fileNames : [...parsedConfig.fileNames, file];
        options = parsedConfig.options;
    }

    const program = ts.createProgram({ rootNames, options });
    const sourceText = fs.readFileSync(file, 'utf-8');
    const lines = sourceText.split('\n');
    let offset = 0;
    for (let index = 0; index < line; index += 1) {
        offset += (lines[index] ?? '').length + 1;
    }
    offset += column;

    const state = resolver(ts, program, file, offset);
    return state.definitions ?? (state.definition ? [state.definition] : []);
}

async function autoRun() {
    try {
        if (fs.existsSync(logFile)) {
            fs.unlinkSync(logFile);
        }

        if (!skipBuild) {
            const buildCommand = runExtensionAutoTest ? `bun run build --test=${testFile}:${testFileLine}:${testFileColumn}` : 'bun run build';
            execSync(buildCommand, {
                stdio: 'inherit',
            });
        }

        const directResults = probeBuiltResolver(testFile, testFileLine, testFileColumn);
        if (directResults.length === 0) {
            console.error(`Built resolver returned no targets for ${testFile}:${testFileLine + 1}:${testFileColumn + 1}`);
        } else {
            console.log('\nBuilt resolver results:');
            for (const result of directResults) {
                console.log(`- ${result.fileName}:${result.name}`);
            }
        }

        if (skipE2E) {
            return;
        }

        if (!skipBuild) {
            execSync(`code --install-extension ${vsixFile} --force --profile web`, {
                stdio: 'inherit',
            });

            console.log('Restarting the extension host so the freshly installed extension activates...');
            await restartExtensionHost();
            await wait(1500);
        } else {
            console.log('Skipping build and installation steps.');
        }

        if (!runExtensionAutoTest) {
            return;
        }

        let tries = 60;
        let logs = '';
        while (tries > 0) {
            if (fs.existsSync(logFile)) {
                logs = fs.readFileSync(logFile, 'utf-8');
                if (logs.trim().length > 0) {
                    break;
                }
            }

            tries--;
            console.log('Waiting for logs to be written. Time left: ', tries * 0.5, 'seconds');
            await wait(500);
        }

        if (!logs) {
            console.error('Logs file was not found after waiting.');
            return;
        }

        console.log(`\n\nExtension logs:\n${logs}`);
    } catch (error) {
        console.error('If the extension host just restarted, wait a moment and run the command again.');
        console.error('Error during self-install:', error);
    }
}

void autoRun();
