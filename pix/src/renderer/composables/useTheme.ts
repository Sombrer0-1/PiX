/**
 * Theme Composable
 *
 * Simple theme management. MVP supports 'light' only.
 * Dark theme infrastructure is in place for future expansion.
 */

import { ref, watch } from "vue";

export type Theme = "light";

const currentTheme = ref<Theme>("light");

export function useTheme() {
  const theme = currentTheme;

  // Apply theme to document
  function applyTheme(t: Theme): void {
    document.documentElement.setAttribute("data-theme", t);
    currentTheme.value = t;
  }

  // Initialize from saved preference
  function initTheme(): void {
    const saved = localStorage.getItem("pix-theme") as Theme | null;
    applyTheme(saved || "light");
  }

  return {
    theme,
    initTheme,
  };
}
