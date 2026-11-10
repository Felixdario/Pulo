/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Endereço da documentação da API (Swagger UI). Padrão: `/api/docs/`, pelo mesmo proxy do app.
   * A barra final importa: o Swagger UI pede os assets em caminho relativo (`./static/…`), e sem ela
   * o HTML aponta para `/docs/static/…`, que fica fora do proxy.
   */
  readonly VITE_API_DOCS_URL?: string;
}
