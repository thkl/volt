import { readFileSync } from 'node:fs';
const FILE_BACKED_SECRET_NAMES = [
    'AUTH_EMAIL',
    'AUTH_PASSWORD',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_ISSUER',
    'OIDC_REDIRECT_URI',
    'OIDC_CLIENT_AUTH_METHOD',
    'INFISICAL_CLIENT_ID',
    'INFISICAL_CLIENT_SECRET',
    'INFISICAL_MACHINE_ID',
    'INFISICAL_MACHINE_TOKEN',
];
export function resolveFileBackedSecrets(env) {
    const resolved = { ...env };
    for (const name of FILE_BACKED_SECRET_NAMES) {
        const result = resolveEnvironmentSecret(env, name);
        if (result.value !== undefined)
            resolved[name] = result.value;
        else if (result.source === 'file-unreadable')
            delete resolved[name];
        delete resolved[`${name}_FILE`];
    }
    return resolved;
}
export function readEnvironmentSecret(env, name) {
    return resolveEnvironmentSecret(env, name).value;
}
export function resolveEnvironmentSecret(env, name) {
    const directValue = env[name];
    if (directValue)
        return { value: directValue, source: 'environment' };
    const filePath = env[`${name}_FILE`]?.trim();
    if (!filePath) {
        return {
            value: directValue,
            source: directValue === undefined ? 'unset' : 'environment',
        };
    }
    let value;
    try {
        value = readFileSync(filePath, 'utf8');
    }
    catch {
        console.warn(JSON.stringify({
            level: 'warn',
            message: `${name}_FILE could not be read; treating the value as unavailable`,
        }));
        return { value: undefined, source: 'file-unreadable' };
    }
    return { value: value.replace(/(?:\r\n|\n|\r)+$/, ''), source: 'file' };
}
