# 小林同学（xltx）

显示名为「小林同学」，启动命令为 `./xltx`，后台服务为 `xltx.service`。已有旧名称服务不自动迁移或停止。

解压后在安装目录操作，不需要预装 Node、npm 或 Pi。当前发行目标为 Linux x86-64；后台运行使用系统自带的 systemd 用户服务。

## 安装

```sh
tar -xzf xltx-0.1.0-linux-x64.tar.gz
cd xltx-0.1.0-linux-x64
./install.sh
```

脚本会校验包内文件、保留旧的 `data/` 和 `workspace/`、问一次模型服务（选服务商后粘贴 API Key）、注册并启动后台服务，最后显示二维码。旧版本保留为相邻的 `xltx.bak.<时间>`，只留最近两个。

直接在源码目录执行 `./install.sh` 同样是一条命令：发现没有现成运行时就先用 `scripts/build.sh` 现场构建（`sudo` 装构建工具并下载一次 Node、Pi 和浏览器）再安装，不需要事先单独打包。

不用脚本时手动执行同样四步：`./xltx check`、`./xltx pi`（配置模型）、`./xltx setup`、`./xltx login`。模型设置和登录凭据保存在本目录的 `data/pi/`；也可以在 `data/environment.json` 中保存模型 API Key，只接受 `*_API_KEY`、`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，不继承宿主机的模型配置或环境变量。

日常命令：`start`、`stop`、`restart`、`status`、`logs`、`logout`。`logs` 显示本地日志并持续刷新，Ctrl+C 退出。

微信使用九个命令：`/new /fork /stop /session /model /thinking /compact /verbose /reload`。`/reload` 强制重启整个后台服务，正在跑的对话会被打断；收到就立即重启，不回复消息。

助手可以浏览网页、点击填写、截图、上传下载、读取 HTML 和执行页面脚本；浏览器随包提供，不需要另行安装，也不会打开可见窗口。网站登录状态保存在安装目录内。每一步最多等 30 秒（下载 60 秒），超时会明确报错，并杀掉挂住的浏览器进程，下次自动重新启动。

## 定时任务

助手可以直接用 `schedule` 工具管理定时任务，不需要图形界面。任务独立运行，不会新开聊天会话；执行结果会主动发到微信。

支持一次性、固定间隔、每天、每周和事件触发，也支持暂停、恢复、删除、立即执行、停止、重试和任务串联。任务定义保存在 `data/tasks.json`，执行记录在 `data/task-runs/`；定义保留，执行记录随 2G／七天规则清理。

退出 SSH 后持续运行、开机自动运行，需要服务器管理员已为当前用户启用 linger；安装时会检查并提示，不自动改动主机登录设置。

## 文件位置及卸载

- `runtime/`：自带 Node、Pi、Bash、BusyBox、rg、fd、无头浏览器及其运行库和字体；不使用系统安装的 Node/Pi/浏览器，不自动更新组件。
- `data/`：配置、凭据、历史、缓存、临时文件和日志。日志位于 `data/logs/`，每份至多 10 MiB，最多保留当前文件及三份轮换文件。
- `workspace/`：默认工作目录；可在配置里改成其他目录。
- 系统自身在目录外只有本服务的 systemd 注册文件及其启用链接。程序输出不写入 journal；systemd 自己的启动/停止记录属于操作系统的服务管理记录。

系统自己的运行环境、依赖、配置、数据、日志和临时文件默认都放在安装目录内；不借用系统已装的 Node、Pi 或浏览器。AI 和它启动的工具不受目录权限限制，可以执行安装目录外的程序，也可以按当前系统用户的权限读写目录外的文件。工作目录默认是安装目录内的 `workspace`。设备 `/dev/null` 用于丢弃输出。Linux 内核、`/proc`、DNS/网络和 systemd 是操作系统设施，不由本包安装。系统服务管理命令仅用于安装、启停和移除本服务。需要的 Bash 及基础命令随包提供，不读取宿主机 shell 初始化文件。Pi 按自身默认规则加载系统提示词、上下文说明文件和项目配置；工作目录中的 `AGENTS.md`、`CLAUDE.md` 及 Pi 支持的自定义提示词配置会正常生效。

数据仍按 2G、七天清理，正在使用的数据延后清理；模型设置、凭据及用户配置保留。运行组件和工作目录不属于七天历史清理范围。

卸载：先执行 `./xltx uninstall` 停止并移除后台服务，然后删除整个安装目录。系统自身写入的内容都在目录内；AI 主动写到目录外的文件不属于安装目录，不会被这一步删除。不删除已有宿主机 Node/Pi、其他软件的凭据或系统历史日志。

移动整个目录前先停止并卸载原位置的后台服务，移动后重新执行 `setup` 注册新位置。会话引用按目录内相对位置保存；恢复搬迁前的旧历史时，仅调整会话头中的工作目录等位置元数据，保留消息正文和原过期时间。历史正文中用户曾经写下的旧路径文字不会被篡改。

`./xltx verify` 检查发行文件的 SHA256、可执行权限及内部链接。下载包可用旁边的 `.sha256` 文件校验。包内不携带任何用户凭据或微信登录态。

## 维护者构建

在 Linux x86-64 构建机上执行：

```sh
./scripts/build.sh
```

脚本会安装构建工具（`sudo` 现场问密码）、按 `portable.json` 下载 Node、按锁文件装依赖、安装 Pi、准备 Playwright 无头浏览器及其依赖闭包和字体，再调用 `scripts/package.mjs` 出包。构建机只产出发行包，不安装、不注册服务；安装是用户侧 `install.sh` 的事。

需要自己控制构建材料时，可以直接调用：

```sh
node scripts/package.mjs --node=/path/to/node --pi=/path/to/pi-coding-agent --bash=/bin/bash --busybox=/usr/bin/busybox --rg=/path/to/rg --fd=/path/to/fd --browser=/path/to/playwright-browsers --browser-libs=/path/to/browser-libs --fonts=/path/to/fonts
```

构建使用 `portable.json` 记录的已验证组件版本，项目依赖按 `package-lock.json` 核验，复制完整 Pi 包及其依赖；浏览器、浏览器运行库和字体作为构建材料传入并校验依赖完整，收集到的运行库与浏览器运行库分开存放；需要 GCC、ldd、tar 和许可证材料。维护者构建环境不属于最终用户运行环境。构建时获取 rg/fd 的许可证，不在用户安装时下载组件。生成 `dist/xltx-{版本}-linux-x64.tar.gz`、同名校验文件及解压目录，包含构建来源记录和逐文件校验清单。不要把 `data/`、`workspace/`、开发缓存或个人环境加入发行包。

## 版本管理

应用版本统一读取 `package.json`，当前为 `0.1.0`；`./xltx version`（也支持 `--version`、`-v`）查看显示名及版本。解压目录如 `xltx-0.1.0-linux-x64`，内部命令始终为 `xltx`。

后续发布前使用 `npm version patch --no-git-tag-version` 升级修订号；新增功能用 `minor`，不兼容变更用 `major`。此操作同步更新包信息及锁文件。版本变更和代码一起提交，再打包验证。

打包将版本写入文件名、内置构建信息和 `releases/xltx-{版本}-linux-x64.json`（含组件版本、文件大小及 SHA256）。已有同版本包或发行记录时拒绝覆盖；旧发行包保留。构建成功不等于测试通过，测试结果另行记录。

Pi 的适配协议不锁死版本号；发行包中的组件版本固定、共同验证后交付，升级通过更换发行包完成。
