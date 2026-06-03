# Vuetify 组件库导航指南

> 本指南帮助您快速找到所需的Vuetify组件及其用法。所有组件文档位于 `docs/src/pages/en/components/` 目录下。

## 📋 目录

1. [快速查找指南](#快速查找指南)
2. [组件分类索引](#组件分类索引)
3. [常用组件速查表](#常用组件速查表)
4. [按场景查找组件](#按场景查找组件)

---

## 快速查找指南

### 我需要...

| 需求 | 推荐组件 | 文档位置 |
|------|----------|----------|
| 创建按钮 | `v-btn` | [buttons.md](docs/src/pages/en/components/buttons.md) |
| 显示卡片内容 | `v-card` | [cards.md](docs/src/pages/en/components/cards.md) |
| 输入文本 | `v-text-field` | [text-fields.md](docs/src/pages/en/components/text-fields.md) |
| 选择选项 | `v-select` | [selects.md](docs/src/pages/en/components/selects.md) |
| 展示数据表格 | `v-data-table` | [data-tables/basics.md](docs/src/pages/en/components/data-tables/basics.md) |
| 创建表单 | `v-form` | [forms.md](docs/src/pages/en/components/forms.md) |
| 显示列表 | `v-list` | [lists.md](docs/src/pages/en/components/lists.md) |
| 创建标签页 | `v-tabs` | [tabs.md](docs/src/pages/en/components/tabs.md) |
| 弹出对话框 | `v-dialog` | [dialogs.md](docs/src/pages/en/components/dialogs.md) |
| 侧边导航 | `v-navigation-drawer` | [navigation-drawers.md](docs/src/pages/en/components/navigation-drawers.md) |

---

## 组件分类索引

### 1. 容器组件 (Containment)

用于包裹其他组件，提供布局和样式。

| 组件 | 功能 | 文档 |
|------|------|------|
| **v-btn** | 按钮，支持多种样式和操作 | [buttons.md](docs/src/pages/en/components/buttons.md) |
| **v-card** | 卡片容器，用于展示内容块 | [cards.md](docs/src/pages/en/components/cards.md) |
| **v-list** | 列表组件，展示数据项 | [lists.md](docs/src/pages/en/components/lists.md) |
| **v-chip** | 标签/芯片，展示小块信息 | [chips.md](docs/src/pages/en/components/chips.md) |
| **v-divider** | 分隔线，区分内容区域 | [dividers.md](docs/src/pages/en/components/dividers.md) |
| **v-expansion-panels** | 折叠面板，展示隐藏内容 | [expansion-panels.md](docs/src/pages/en/components/expansion-panels.md) |
| **v-menu** | 菜单，展示操作列表 | [menus.md](docs/src/pages/en/components/menus.md) |
| **v-dialog** | 对话框，显示重要信息 | [dialogs.md](docs/src/pages/en/components/dialogs.md) |
| **v-bottom-sheet** | 底部滑出面板 | [bottom-sheets.md](docs/src/pages/en/components/bottom-sheets.md) |
| **v-overlay** | 遮罩层，覆盖应用内容 | [overlays.md](docs/src/pages/en/components/overlays.md) |
| **v-toolbar** | 工具栏，展示操作和标题 | [toolbars.md](docs/src/pages/en/components/toolbars.md) |
| **v-tooltip** | 工具提示，悬停显示信息 | [tooltips.md](docs/src/pages/en/components/tooltips.md) |
| **v-sheet** | 基础容器，简单的纸张效果 | [sheets.md](docs/src/pages/en/components/sheets.md) |

### 2. 导航组件 (Navigation)

用于在不同视图或页面间导航。

| 组件 | 功能 | 文档 |
|------|------|------|
| **v-app-bar** | 应用栏，顶部导航 | [app-bars.md](docs/src/pages/en/components/app-bars.md) |
| **v-btn (FAB)** | 浮动操作按钮 | [floating-action-buttons.md](docs/src/pages/en/components/floating-action-buttons.md) |
| **v-navigation-drawer** | 导航抽屉，侧边栏 | [navigation-drawers.md](docs/src/pages/en/components/navigation-drawers.md) |
| **v-pagination** | 分页组件 | [paginations.md](docs/src/pages/en/components/paginations.md) |
| **v-bottom-navigation** | 底部导航，移动端使用 | [bottom-navigation.md](docs/src/pages/en/components/bottom-navigation.md) |
| **v-breadcrumbs** | 面包屑导航 | [breadcrumbs.md](docs/src/pages/en/components/breadcrumbs.md) |
| **v-footer** | 页脚，内部链接 | [footers.md](docs/src/pages/en/components/footers.md) |
| **v-speed-dial** | 速度拨号，展开更多操作 | [speed-dials.md](docs/src/pages/en/components/speed-dials.md) |
| **v-system-bar** | 系统栏，显示应用信息 | [system-bars.md](docs/src/pages/en/components/system-bars.md) |
| **v-tabs** | 标签页，组织内容 | [tabs.md](docs/src/pages/en/components/tabs.md) |

### 3. 表单输入组件 (Form Inputs and Controls)

用于收集用户输入。

| 组件 | 功能 | 文档 |
|------|------|------|
| **v-autocomplete** | 自动完成，输入建议 | [autocompletes.md](docs/src/pages/en/components/autocompletes.md) |
| **v-combobox** | 组合框，可输入自定义值 | [combobox.md](docs/src/pages/en/components/combobox.md) |
| **v-text-field** | 文本输入框 | [text-fields.md](docs/src/pages/en/components/text-fields.md) |
| **v-checkbox** | 复选框 | [checkboxes.md](docs/src/pages/en/components/checkboxes.md) |
| **v-switch** | 开关，复选框的替代样式 | [switches.md](docs/src/pages/en/components/switches.md) |
| **v-radio** | 单选按钮 | [radio-buttons.md](docs/src/pages/en/components/radio-buttons.md) |
| **v-file-input** | 文件上传输入 | [file-inputs.md](docs/src/pages/en/components/file-inputs.md) |
| **v-form** | 表单容器，统一验证 | [forms.md](docs/src/pages/en/components/forms.md) |
| **v-input** | 自定义输入基础组件 | [inputs.md](docs/src/pages/en/components/inputs.md) |
| **v-number-input** | 数字输入框 | [number-inputs.md](docs/src/pages/en/components/number-inputs.md) |
| **v-otp-input** | OTP验证码输入 | [otp-input.md](docs/src/pages/en/components/otp-input.md) |
| **v-select** | 下拉选择器 | [selects.md](docs/src/pages/en/components/selects.md) |
| **v-slider** | 滑块，选择数值范围 | [sliders.md](docs/src/pages/en/components/sliders.md) |
| **v-range-slider** | 范围滑块，选择区间 | [range-sliders.md](docs/src/pages/en/components/range-sliders.md) |
| **v-textarea** | 多行文本输入 | [textareas.md](docs/src/pages/en/components/textareas.md) |

### 4. 布局组件 (Layouts)

用于创建响应式布局。

| 组件 | 功能 | 文档 |
|------|------|------|
| **v-row / v-col** | 栅格系统，响应式布局 | [grids.md](docs/src/pages/en/components/grids.md) |

### 5. 选择组件 (Selection)

用于从选项中选择一个或多个。

| 组件 | 功能 | 文档 |
|------|------|------|
| **v-carousel** | 轮播图，展示多张图片 | [carousels.md](docs/src/pages/en/components/carousels.md) |
| **v-btn-toggle** | 按钮组，多选一 | [button-groups.md](docs/src/pages/en/components/button-groups.md) |
| **v-chip-group** | 标签组，可选择标签 | [chip-groups.md](docs/src/pages/en/components/chip-groups.md) |
| **v-window** | 窗口组件，内容切换 | [windows.md](docs/src/pages/en/components/windows.md) |
| **v-stepper** | 步骤条，分步表单 | [steppers.md](docs/src/pages/en/components/steppers.md) |

### 6. 数据展示组件 (Data and Display)

用于展示数据和信息。

| 组件 | 功能 | 文档 |
|------|------|------|
| **v-confirm-edit** | 确认编辑，数据修改确认 | [confirm-edit.md](docs/src/pages/en/components/confirm-edit.md) |
| **v-data-iterator** | 数据迭代器，分页排序 | [data-iterators.md](docs/src/pages/en/components/data-iterators.md) |
| **v-data-table** | 数据表格，展示大量数据 | [data-tables/basics.md](docs/src/pages/en/components/data-tables/basics.md) |
| **v-infinite-scroll** | 无限滚动，加载更多 | [infinite-scroller.md](docs/src/pages/en/components/infinite-scroller.md) |
| **v-data-table (服务端)** | 服务端数据表格 | [data-tables/server-side-tables.md](docs/src/pages/en/components/data-tables/server-side-tables.md) |
| **v-sparkline** | 迷你图表，展示数值数据 | [sparklines.md](docs/src/pages/en/components/sparklines.md) |
| **v-data-table (虚拟)** | 虚拟滚动表格，大数据集 | [data-tables/virtual-tables.md](docs/src/pages/en/components/data-tables/virtual-tables.md) |
| **v-table** | 基础表格，原生table替代 | [tables.md](docs/src/pages/en/components/tables.md) |
| **v-virtual-scroll** | 虚拟滚动，高性能列表 | [virtual-scroller.md](docs/src/pages/en/components/virtual-scroller.md) |

### 7. 反馈组件 (Feedback)

用于向用户提供反馈。

| 组件 | 功能 | 文档 |
|------|------|------|
| **v-alert** | 警告提示，重要信息 | [alerts.md](docs/src/pages/en/components/alerts.md) |
| **v-badge** | 徽章，角标显示 | [badges.md](docs/src/pages/en/components/badges.md) |
| **v-banner** | 横幅，重要通知 | [banners.md](docs/src/pages/en/components/banners.md) |
| **v-empty-state** | 空状态，无内容提示 | [empty-states.md](docs/src/pages/en/components/empty-states.md) |
| **v-skeleton-loader** | 骨架屏，加载占位 | [skeleton-loaders.md](docs/src/pages/en/components/skeleton-loaders.md) |
| **v-snackbar** | 消息条，临时提示 | [snackbars.md](docs/src/pages/en/components/snackbars.md) |
| **v-rating** | 评分组件，收集反馈 | [ratings.md](docs/src/pages/en/components/ratings.md) |
| **v-timeline** | 时间线，按时间展示事件 | [timelines.md](docs/src/pages/en/components/timelines.md) |
| **v-hover** | 悬停状态，响应鼠标悬停 | [hover.md](docs/src/pages/en/components/hover.md) |
| **v-progress-circular** | 圆形进度条 | [progress-circular.md](docs/src/pages/en/components/progress-circular.md) |
| **v-progress-linear** | 线性进度条 | [progress-linear.md](docs/src/pages/en/components/progress-linear.md) |

### 8. 图片和图标组件 (Images and Icons)

用于展示媒体内容。

| 组件 | 功能 | 文档 |
|------|------|------|
| **v-aspect-ratio** | 宽高比容器 | [aspect-ratios.md](docs/src/pages/en/components/aspect-ratios.md) |
| **v-avatar** | 头像，展示用户图片 | [avatars.md](docs/src/pages/en/components/avatars.md) |
| **v-icon** | 图标组件 | [icons.md](docs/src/pages/en/components/icons.md) |
| **v-img** | 图片组件，灵活展示图片 | [images.md](docs/src/pages/en/components/images.md) |
| **v-parallax** | 视差效果，3D滚动效果 | [parallax.md](docs/src/pages/en/components/parallax.md) |

### 9. 选择器组件 (Pickers)

用于从特定样式的选项中选择。

| 组件 | 功能 | 文档 |
|------|------|------|
| **v-color-picker** | 颜色选择器 | [color-pickers.md](docs/src/pages/en/components/color-pickers.md) |
| **v-date-picker** | 日期选择器 | [date-pickers.md](docs/src/pages/en/components/date-pickers.md) |

### 10. 提供者组件 (Providers)

用于提供全局配置。

| 组件 | 功能 | 文档 |
|------|------|------|
| **v-defaults-provider** | 默认值提供者 | [defaults-providers.md](docs/src/pages/en/components/defaults-providers.md) |
| **v-locale-provider** | 语言环境提供者 | [locale-providers.md](docs/src/pages/en/components/locale-providers.md) |
| **v-theme-provider** | 主题提供者 | [theme-providers.md](docs/src/pages/en/components/theme-providers.md) |

### 11. 其他组件 (Miscellaneous)

| 组件 | 功能 | 文档 |
|------|------|------|
| **v-lazy** | 懒加载，可见时才渲染 | [lazy.md](docs/src/pages/en/components/lazy.md) |
| **v-no-ssr** | 禁止服务端渲染 | [no-ssr.md](docs/src/pages/en/components/no-ssr.md) |

---

## 常用组件速查表

### 基础UI组件

```vue
<!-- 按钮 -->
<v-btn color="primary">点击我</v-btn>

<!-- 卡片 -->
<v-card>
  <v-card-title>标题</v-card-title>
  <v-card-text>内容</v-card-text>
</v-card>

<!-- 图标 -->
<v-icon>mdi-home</v-icon>

<!-- 头像 -->
<v-avatar size="56">
  <v-img src="avatar.jpg"></v-img>
</v-avatar>
```

### 表单组件

```vue
<!-- 文本输入 -->
<v-text-field label="姓名" v-model="name"></v-text-field>

<!-- 下拉选择 -->
<v-select :items="options" label="选择" v-model="selected"></v-select>

<!-- 复选框 -->
<v-checkbox label="同意" v-model="agreed"></v-checkbox>

<!-- 开关 -->
<v-switch label="启用" v-model="enabled"></v-switch>

<!-- 表单 -->
<v-form @submit.prevent="submit">
  <v-text-field label="邮箱" type="email"></v-text-field>
  <v-btn type="submit">提交</v-btn>
</v-form>
```

### 数据展示

```vue
<!-- 数据表格 -->
<v-data-table :items="items" :headers="headers"></v-data-table>

<!-- 列表 -->
<v-list>
  <v-list-item v-for="item in items" :key="item.id">
    <v-list-item-title>{{ item.name }}</v-list-item-title>
  </v-list-item>
</v-list>

<!-- 标签页 -->
<v-tabs>
  <v-tab>标签1</v-tab>
  <v-tab>标签2</v-tab>
</v-tabs>
```

### 反馈组件

```vue
<!-- 警告提示 -->
<v-alert type="success">操作成功</v-alert>

<!-- 消息条 -->
<v-snackbar v-model="show">消息内容</v-snackbar>

<!-- 进度条 -->
<v-progress-linear indeterminate></v-progress-linear>

<!-- 骨架屏 -->
<v-skeleton-loader type="card"></v-skeleton-loader>
```

### 布局组件

```vue
<!-- 栅格布局 -->
<v-row>
  <v-col cols="12" md="6">内容1</v-col>
  <v-col cols="12" md="6">内容2</v-col>
</v-row>

<!-- 导航抽屉 -->
<v-navigation-drawer v-model="drawer">
  <v-list>...</v-list>
</v-navigation-drawer>

<!-- 对话框 -->
<v-dialog v-model="dialog" max-width="500">
  <v-card>...</v-card>
</v-dialog>
```

---

## 按场景查找组件

### 用户认证场景

| 功能 | 组件 | 说明 |
|------|------|------|
| 登录表单 | `v-form` + `v-text-field` | 邮箱/密码输入 |
| 记住我 | `v-checkbox` | 复选框选择 |
| 登录按钮 | `v-btn` | 提交表单 |
| 错误提示 | `v-alert` | 显示错误信息 |
| 加载状态 | `v-progress-circular` | 登录中... |

### 数据管理场景

| 功能 | 组件 | 说明 |
|------|------|------|
| 数据展示 | `v-data-table` | 表格展示数据 |
| 数据筛选 | `v-select` + `v-text-field` | 筛选条件 |
| 分页 | `v-pagination` | 数据分页 |
| 操作按钮 | `v-btn` | 增删改查 |
| 确认删除 | `v-dialog` | 确认对话框 |

### 电商场景

| 功能 | 组件 | 说明 |
|------|------|------|
| 商品卡片 | `v-card` | 展示商品信息 |
| 商品图片 | `v-img` + `v-carousel` | 商品轮播图 |
| 价格显示 | `v-chip` | 价格标签 |
| 购物车 | `v-badge` | 购物车角标 |
| 底部导航 | `v-bottom-navigation` | 移动端导航 |

### 仪表盘场景

| 功能 | 组件 | 说明 |
|------|------|------|
| 统计卡片 | `v-card` + `v-icon` | 数据统计 |
| 图表 | `v-sparkline` | 迷你图表 |
| 进度展示 | `v-progress-circular` | 完成度 |
| 数据表格 | `v-data-table` | 详细数据 |
| 侧边导航 | `v-navigation-drawer` | 菜单导航 |

### 表单向导场景

| 功能 | 组件 | 说明 |
|------|------|------|
| 步骤条 | `v-stepper` | 分步引导 |
| 表单输入 | `v-text-field` + `v-select` | 收集信息 |
| 表单验证 | `v-form` | 验证规则 |
| 上一步/下一步 | `v-btn` | 步骤切换 |
| 提交确认 | `v-dialog` | 确认提交 |

---

## 组件导入方式

### 全局导入 (推荐用于大型项目)

```js
// main.js
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'

const vuetify = createVuetify({
  components,
})

app.use(vuetify)
```

### 按需导入 (推荐用于性能优化)

```js
// main.js
import { createVuetify } from 'vuetify'
import { VBtn, VCard, VTextField } from 'vuetify/components'

const vuetify = createVuetify({
  components: {
    VBtn,
    VCard,
    VTextField,
  },
})

app.use(vuetify)
```

### 自动导入 (使用插件)

安装 `unplugin-vue-components` 和 `unplugin-auto-import` 插件可实现自动导入。

---

## 更多资源

- [Vuetify 官方文档](https://vuetifyjs.com/)
- [组件 API 参考](https://vuetifyjs.com/api/)
- [GitHub 仓库](https://github.com/vuetifyjs/vuetify)
- [示例代码](https://github.com/vuetifyjs/vuetify/tree/master/packages/docs/src/examples)

---

> 💡 **提示**: 本文档基于 Vuetify 3.x 版本。所有组件文档均位于 `docs/src/pages/en/components/` 目录下，可直接点击链接访问。
