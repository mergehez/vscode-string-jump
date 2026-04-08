# Changelog

## 0.0.2 - 0.0.3

- Improves startup behavior by removing the TypeScript server restart from normal activation.
- Defers underline decoration startup to reduce activation pressure.
- Leaves native module-specifier navigation to VS Code for import and export path strings.
- Keeps semantic navigation for supported string literals and reverse-definition targets.

## 0.0.1

- Initial public release of String Jump.
- Adds semantic navigation between string literals, declaration names, and definitions in TypeScript and JavaScript.
- Includes underline decorations for resolvable string literals.
- Adds reverse-definition results for supported declaration names.
- Adds `hide-declaration` and `hide-imports` settings for definition results.
- Covers union-constrained literals, contextual typing cases, route keys, controller tuple handlers, controller references, and model/query-builder string keys.
