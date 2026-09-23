/// <reference types="node" />
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

type BuildOptions = {
    testTarget?: string;
    testLogFile?: string;
    bumpVersion?: boolean;
    /** Test runs only need dist/, not the packaged vsix. */
    packageVsix?: boolean;
};

function readEnvFile(filePath: string): Record<string, string> {
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

export function buildExtension({ testTarget, testLogFile: logFileOverride, bumpVersion, packageVsix = true }: BuildOptions = {}): void {
    const [testFile, testFileLine, testFileColumn] = testTarget ? testTarget.split(':') : ['', '', ''];
    const test = Boolean(testTarget);
    const env = readEnvFile(path.join(projectRoot, '.env'));
    const testLogFile = logFileOverride ?? process.env.STRING_JUMP_TEST_LOG_FILE ?? env.STRING_JUMP_TEST_LOG_FILE ?? '';
    const extensionBundlePath = path.join(projectRoot, 'dist', 'extension.js');

    execSync('npx tsc -p ./', { stdio: 'inherit', cwd: projectRoot });

    if (bumpVersion) {
        bumpPatchVersion();
    }

    const tsServerPluginPackageDir = path.join(projectRoot, 'node_modules', 'string-jump-tsserver-plugin');
    fs.mkdirSync(tsServerPluginPackageDir, { recursive: true });
    fs.writeFileSync(
        path.join(tsServerPluginPackageDir, 'package.json'),
        JSON.stringify(
            {
                name: 'string-jump-tsserver-plugin',
                private: true,
                main: './index.cjs',
            },
            null,
            2
        ) + '\n',
        'utf-8'
    );
    fs.writeFileSync(path.join(tsServerPluginPackageDir, 'index.cjs'), "module.exports = require('../../dist/tsserver-plugin.cjs');\n", 'utf-8');

    let res = fs.readFileSync(extensionBundlePath, 'utf-8');
    const date = new Date().toISOString();
    const timeStr = date.split('T')[1].split('.')[0];
    const datetimeStr = `${date.split('T')[0]} ${timeStr}`;
    console.log(`Replacing time placeholders with '${datetimeStr}' and '${timeStr}'`);
    res = res.replace('[TO-REPLACE-WITH-BUILD-DATE-TIME]', datetimeStr);
    res = res.replace('[TO-REPLACE-WITH-BUILD-TIME]', timeStr);
    res = res.replace('[TO-REPLACE-TEST-FILE]', testFile);
    res = res.replace('[TO-REPLACE-TEST-FILE-LINE]', testFileLine);
    res = res.replace('[TO-REPLACE-TEST-FILE-COLUMN]', testFileColumn);
    res = res.replace('[TO-REPLACE-TEST-LOG-FILE]', test ? testLogFile : '');
    fs.writeFileSync(extensionBundlePath, res, 'utf-8');

    if (packageVsix) {
        execSync('npx vsce package', { stdio: 'inherit', cwd: projectRoot });
    }
}

function bumpPatchVersion(): void {
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const contents = fs.readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(contents) as { version: string };
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version);
    if (!match) {
        throw new Error(`Cannot bump version "${packageJson.version}": expected <major>.<minor>.<patch>.`);
    }

    const nextVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
    const indentation = /^([ \t]+)"/m.exec(contents)?.[1] ?? '    ';
    fs.writeFileSync(packageJsonPath, JSON.stringify({ ...packageJson, version: nextVersion }, null, indentation) + (contents.endsWith('\n') ? '\n' : ''), 'utf-8');
    console.log(`Bumped version ${packageJson.version} -> ${nextVersion}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    buildExtension({
        testTarget: process.argv.find((value) => value.startsWith('--test'))?.split('=')[1],
        bumpVersion: process.argv.includes('--up'),
        packageVsix: !process.argv.includes('--skip-package'),
    });
}
