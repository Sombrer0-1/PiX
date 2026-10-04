/**
 * Vue Application Entry Point
 */

import { createApp } from "vue";
import { createPinia } from "pinia";
import { createVuetify } from "vuetify";
import { zhHans } from "vuetify/locale";
import * as vuetifyComponents from "vuetify/components";
import * as vuetifyDirectives from "vuetify/directives";
import "vuetify/styles";
import "@mdi/font/css/materialdesignicons.css";
import "katex/dist/katex.min.css";
import App from "./App.vue";
import router from "./router";
import "./assets/styles/main.css";
import "./types/ipc"; // Register global type declarations

const vuetify = createVuetify({
  components: { ...vuetifyComponents },
  directives: { ...vuetifyDirectives },
  locale: {
    locale: "zhHans",
    fallback: "zhHans",
    messages: { zhHans },
  },
  defaults: {
    global: {
      ripple: false,
    },
    VTextField: {
      variant: "outlined",
      density: "comfortable",
      color: "primary",
    },
    VTextarea: {
      variant: "outlined",
      density: "comfortable",
      color: "primary",
    },
    VSelect: {
      variant: "outlined",
      density: "comfortable",
      color: "primary",
    },
    VBtn: {
      variant: "text",
      color: "primary",
    },
    VSwitch: {
      color: "primary",
      density: "comfortable",
    },
    VCard: {
      variant: "elevated",
    },
    VTabs: {
      color: "primary",
    },
  },
  theme: {
    defaultTheme: "light",
    themes: {
      light: {
        colors: {
          background: "#ffffff",
          surface: "#ffffff",
          "surface-variant": "#f8f9fb",
          primary: "#6b5ce7",
          "primary-darken-1": "#584bcc",
          secondary: "#30394b",
          "secondary-darken-1": "#334155",
          error: "#bf575d",
          success: "#368967",
          warning: "#f59e0b",
          "on-background": "#202737",
          "on-surface": "#202737",
          "on-surface-variant": "#30394b",
          "on-primary": "#ffffff",
          "border-color": "#e8eaf0",
        },
      },
    },
  },
});

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(vuetify);

app.mount("#app");
