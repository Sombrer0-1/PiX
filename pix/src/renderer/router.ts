/**
 * Vue Router Configuration
 */

import { createRouter, createMemoryHistory, type RouteRecordRaw } from "vue-router";
import HomePage from "./pages/HomePage.vue";
import WorkspacePage from "./pages/WorkspacePage.vue";
import SettingsPage from "./pages/SettingsPage.vue";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "home",
    component: HomePage,
  },
  {
    path: "/workspace",
    name: "workspace",
    component: WorkspacePage,
  },
  {
    path: "/settings",
    name: "settings",
    component: SettingsPage,
  },
];

const router = createRouter({
  history: createMemoryHistory(),
  routes,
});

export default router;
