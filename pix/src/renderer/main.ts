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
          background: "#f0f0f0",
          surface: "#ffffff",
          "surface-variant": "#f5f5f5",
          primary: "#3a6da5",
          "primary-darken-1": "#2d5580",
          secondary: "#5a5a5a",
          "secondary-darken-1": "#404040",
          error: "#b84a4a",
          success: "#3d7a4f",
          warning: "#b8953a",
          "on-background": "#1a1a1a",
          "on-surface": "#1a1a1a",
          "on-surface-variant": "#5a5a5a",
          "on-primary": "#ffffff",
          "border-color": "#d4d4d4",
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
