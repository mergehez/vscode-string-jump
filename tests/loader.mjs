// Maps the `vscode` import inside dist/extension.js to the stub, so the built extension host can be
// imported in Node.
export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') {
        return { url: new URL('./vscode-stub.mjs', import.meta.url).href, shortCircuit: true };
    }

    return nextResolve(specifier, context);
}
