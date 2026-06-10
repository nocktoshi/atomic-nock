// Wrangler/esbuild turns a `.wasm` import into a compiled WebAssembly.Module.
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
