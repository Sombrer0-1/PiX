/**
 * Vue Application Entry Point
 */

import { createApp } from "vue";
import { createPinia } from "pinia";
import { createVuetify } from "vuetify";
import * as vuetifyComponents from "vuetify/components";
import * as vuetifyDirectives from "vuetify/directives";
import "vuetify/styles";
import "@mdi/font/css/materialdesignicons.css";
import App from "./App.vue";
import router from "./router";
import "./assets/styles/main.css";
import "./types/ipc"; // Register global type declarations

const vuetify = createVuetify({
  components: { ...vuetifyComponents },
  directives: { ...vuetifyDirectives },
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
      variant: "outlined",
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
          background: "#f5f6f8",
          surface: "#ffffff",
          "surface-variant": "#f8f9fb",
          primary: "#3a6da5",
          "primary-darken-1": "#2d5580",
          secondary: "#475569",
          "secondary-darken-1": "#334155",
          error: "#c92a2a",
          success: "#2b8a3e",
          warning: "#e67700",
          "on-background": "#1e293b",
          "on-surface": "#1e293b",
          "on-surface-variant": "#475569",
          "on-primary": "#ffffff",
          "border-color": "#dee2e6",
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
