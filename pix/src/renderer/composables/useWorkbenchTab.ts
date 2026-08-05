/**
 * useWorkbenchTab - Shared TeamDashboard workbench tab state.
 *
 * Lifts the active tab and activity mode out of TeamDashboard so sibling
 * components (e.g. WorkerStatusBar) can navigate the workbench on user
 * actions, mirroring focusTaskOwner without reaching into the dashboard's
 * internals. Module-level state is appropriate: a single dashboard instance
 * exists per team workspace, matching the useTheme/useRpc singleton pattern.
 */
import { ref } from "vue";

export type WorkbenchTab = "tasks" | "activity" | "changes" | "messages";
export type ActivityMode = "focused" | "all";

const activeTab = ref<WorkbenchTab>("tasks");
const activityMode = ref<ActivityMode>("focused");

export function useWorkbenchTab() {
  /** Switch to the activity tab in focused-worker mode. */
  function showActivityFocused(): void {
    activityMode.value = "focused";
    activeTab.value = "activity";
  }

  /** Switch to the tasks tab (problem tasks sort to the top of the list). */
  function showTasks(): void {
    activeTab.value = "tasks";
  }

  return {
    activeTab,
    activityMode,
    showActivityFocused,
    showTasks,
  };
}
