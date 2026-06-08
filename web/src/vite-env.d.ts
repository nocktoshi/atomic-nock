/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENVOY_URL: string;
  readonly VITE_HTLC_ADDRESS: string;
  readonly VITE_CHAIN_ID: string;
}

interface ImportMetaEnv {
  [key: string]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

