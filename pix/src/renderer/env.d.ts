/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface PixApi {
  openExternal: (url: string) => void;
  [key: string]: unknown;
}

declare global {
  interface Window {
    pixApi: PixApi;
  }
}
