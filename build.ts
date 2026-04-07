/// <reference types="node" />
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const test = process.argv.find((t) => t.startsWith('--test'));
const testFileArg = test ? test.split('=')[1] : '';
const [testFile, testFileLine, testFileColumn] = testFileArg ? testFileArg.split(':') : ['', '', ''];
const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const env = readEnvFile(path.join(projectRoot, '.env'));
const testLogFile = process.env.STRING_JUMP_TEST_LOG_FILE ?? env.STRING_JUMP_TEST_LOG_FILE ?? '';

execSync('npx tsc -p ./', { stdio: 'inherit' });

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

let res = fs.readFileSync('dist/extension.js', 'utf-8');
const date = new Date().toISOString();
const timeStr = date.split('T')[1].split('.')[0];
const datetimeStr = `${date.split('T')[0]} ${timeStr}`;
console.log(`Replacing time placeholders with '${datetimeStr}' and '${timeStr}'`);
res = res.replace('[TO-REPLACE-WITH-BUILD-DATE-TIME]', datetimeStr);
res = res.replace('[TO-REPLACE-WITH-BUILD-TIME]', timeStr);
res = res.replace('[TO-REPLACE-TEST-FILE]', testFile ?? '');
res = res.replace('[TO-REPLACE-TEST-FILE-LINE]', testFileLine ?? '');
res = res.replace('[TO-REPLACE-TEST-FILE-COLUMN]', testFileColumn ?? '');
res = res.replace('[TO-REPLACE-TEST-LOG-FILE]', test ? testLogFile : '');
fs.writeFileSync('dist/extension.js', res, 'utf-8');
