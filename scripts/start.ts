/**
 * 生产启动入口：在加载服务前注入 NODE_ENV=production，替代 POSIX 的 `NODE_ENV=production node ...`
 * 内联写法，使 `npm start` 在 Windows / macOS / Linux 上行为一致。
 * 必须用动态 import——config 在模块加载时就读环境变量，静态 import 会先于赋值执行。
 */
process.env.NODE_ENV = 'production';
await import('../server/index.ts');