/**
 * 客户端装载器 wrapper —— 真源。
 *
 * 构建时 scripts/build.mjs 把 plugin-src/client/impl.mjs 插到 __DSH_CLIENT_IMPL__ 处，
 * **插在 factory 函数体内部**。
 *
 * 为什么必须在 factory 内部：impl.mjs 里会用到 React，而 DSH 的 React 是通过
 * factory 的参数 `require` 在**运行时**解析的。放到 factory 外面就会在脚本顶层执行，
 * 拿到的是 undefined —— 整个 /plugins 拼接 bundle 会因此全灭，
 * 而报错会出现在别的插件上（例如 client-connection 未注册），极难归因。
 *
 * 平台冻结模块表只提供 react / react-dom / react/jsx-runtime / react-dom/client。
 */
window.__ModuleLoader__.load({
  id: '@yiyunet/dsh-kill-ai-slop',
  factory: require => {
    // __DSH_CLIENT_IMPL__
    return createClientPlugin(require('react'))
  },
})
