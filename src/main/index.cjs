// Development bootstrap: register ts-node then load the TypeScript main
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS' } });
require('./index.ts');
