/**
 * Todo Store (R3)
 *
 * Pinia 只读镜像：清单真源在主进程 TodoController（随 RuntimeGeneration 存活的
 * 内存态），模型经 todo_write 工具全量写入；渲染端零写路径，每次变化要么是
 * todo_state 事件（整体替换），要么是 get_snapshot 重挂载追平。结构与
 * plan-store 同款（替换式订阅 + 快照追平）。
 *
 * 完成收尾摘要：controller 在"全部 completed"时自动存 []（CC 同款语义），
 * 镜像端记住被收尾清空前的条数（clearedCount），TodoCard 据此渲染常驻的
 * "全部完成"汇总行——不自动消失，避免用户错过；下一次非空写入或会话切换
 * 即清除。会话边界用快照携带的 sessionId 判定，切到新会话的空快照不会被
 * 误认作本会话的完成收尾。
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useTodoRpc } from "../composables/useTodoRpc";
import type { TodoEvent, TodoItem, TodoSnapshot } from "@shared/todo-types.js";

export const useTodoStore = defineStore("todo", () => {
	const todoRpc = useTodoRpc();

	// ==========================================================================
	// State
	// ==========================================================================

	/** 当前清单条目（todo_state 全量替换）。 */
	const items = ref<TodoItem[]>([]);

	/** 最近一次快照的更新时间；null = 尚未收到任何快照。 */
	const updatedAt = ref<number | null>(null);

	/** 镜像归属会话（完成收尾摘要的会话边界判定）。 */
	const sessionId = ref<string | null>(null);

	/**
	 * 完成收尾摘要：被"全部 completed → 自动清空"收掉时的条数；null = 无摘要。
	 */
	const clearedCount = ref<number | null>(null);

	// ==========================================================================
	// Computed
	// ==========================================================================

	const completedCount = computed(() => items.value.filter((item) => item.status === "completed").length);

	/** 卡片可见性：有条目，或处于完成后摘要态（RightPanel 的 v-if 消费）。 */
	const hasVisibleContent = computed(() => items.value.length > 0 || clearedCount.value !== null);

	// ==========================================================================
	// Snapshot / event handling
	// ==========================================================================

	/** todo_state / get_snapshot → 整体替换（只读镜像，无任何合并逻辑）。 */
	function applySnapshot(snapshot: TodoSnapshot): void {
		const sessionChanged = sessionId.value !== null && snapshot.sessionId !== sessionId.value;
		if (snapshot.items.length === 0 && items.value.length > 0 && !sessionChanged) {
			// 同一会话内 非空 → 空：controller 的完成收尾（或模型显式清空），
			// 保留条数供"全部完成"汇总行展示。
			clearedCount.value = items.value.length;
		} else if (snapshot.items.length > 0 || sessionChanged) {
			clearedCount.value = null;
		}
		items.value = snapshot.items;
		updatedAt.value = snapshot.updatedAt;
		sessionId.value = snapshot.sessionId;
	}

	function handleTodoEvent(event: TodoEvent): void {
		if (event.type === "todo_state") {
			applySnapshot(event.snapshot);
		}
	}

	// ==========================================================================
	// Subscription
	// ==========================================================================

	let unsubscribeTodoEvents: (() => void) | null = null;

	/**
	 * 订阅 todo 事件并追平当前快照。重挂载（窗口重开 / 组件重挂）时替换上一次
	 * 订阅而不是叠加第二个监听（每个事件只处理一次）。订阅生效后再查询权威快照，
	 * 追平窗口内先到的推送不会被更旧的快照响应覆盖。
	 */
	function subscribeToEvents(): () => void {
		if (unsubscribeTodoEvents) {
			unsubscribeTodoEvents();
		}
		const off = todoRpc.onTodoEvent((event) => {
			handleTodoEvent(event);
		});
		unsubscribeTodoEvents = () => {
			off();
			unsubscribeTodoEvents = null;
		};
		void refreshSnapshot();
		return unsubscribeTodoEvents;
	}

	/** 查询权威快照（重挂载追平）。 */
	async function refreshSnapshot(): Promise<TodoSnapshot | null> {
		try {
			const result = await todoRpc.sendTodoCommand({ type: "get_snapshot" });
			if (result.success && result.data) {
				applySnapshot(result.data);
				return result.data;
			}
			return null;
		} catch (err) {
			console.error("[todo-store] Failed to get todo snapshot:", err);
			return null;
		}
	}

	/** 会话切换清空镜像（快照收敛已覆盖，防御性兜底）。 */
	function clear(): void {
		items.value = [];
		updatedAt.value = null;
		sessionId.value = null;
		clearedCount.value = null;
	}

	// ==========================================================================
	// Expose
	// ==========================================================================

	return {
		// State
		items,
		updatedAt,
		sessionId,
		clearedCount,
		// Computed
		completedCount,
		hasVisibleContent,
		// Subscription
		subscribeToEvents,
		refreshSnapshot,
		clear,
	};
});
