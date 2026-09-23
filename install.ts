/// <reference types="node" />
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildExtension } from './build.ts';

// Builds the extension and installs it into one VS Code profile. Run it directly
// (node install.ts --profile=web) or import installExtensionToProfile from the harness.

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

type InstallOptions = {
    profile: string;
    vsixFile?: string;
    build?: boolean;
    bumpVersion?: boolean;
};

export function installExtensionToProfile({ profile, vsixFile, build = true, bumpVersion }: InstallOptions): void {
    if (build) {
        buildExtension({ bumpVersion });
    }

    // Resolved after the build so a version bump is picked up.
    const packageFile = vsixFile ?? defaultVsixFile();
    const packagePath = path.isAbsolute(packageFile) ? packageFile : path.join(projectRoot, packageFile);

    if (!fs.existsSync(packagePath)) {
        throw new Error(`Extension package not found: ${packagePath}. Run "node build.ts" first.`);
    }

    // Profiles keep separate extension sets, so every install has to name one.
    console.log(`Installing ${path.basename(packagePath)} into the "${profile}" profile...`);
    execSync(`code --profile ${quote(profile)} --install-extension ${quote(packagePath)} --force`, { stdio: 'inherit' });
    // A running window keeps the extension host it already loaded; only the TypeScript server reads the new
    // plugin file on its next restart.
    console.log('Reload the VS Code window so the extension host runs the freshly installed build.');
}

function defaultVsixFile(): string {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')) as { version: string };
    return `string-jump-${packageJson.version}.vsix`;
}

function parseArgs(argv: string[]): InstallOptions {
    const profile = argv.find((value) => value.startsWith('--profile='))?.split('=')[1];
    if (!profile) {
        throw new Error('Missing profile. Example: node install.ts --profile=web [--up] [--skip-build] [--vsix=file.vsix]');
    }

    return {
        profile,
        vsixFile: argv.find((value) => value.startsWith('--vsix='))?.split('=')[1],
        build: !argv.includes('--skip-build') && !argv.includes('-s'),
        bumpVersion: argv.includes('--up'),
    };
}

function quote(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    installExtensionToProfile(parseArgs(process.argv.slice(2)));
}
