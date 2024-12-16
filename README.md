# Maven POM Downloader

一个用于从Maven仓库下载依赖的Node.js工具。该工具可以解析pom.xml文件，并从阿里云Maven镜像仓库下载所有依赖及其传递依赖。

## 功能特点

- 解析pom.xml文件中的依赖配置
- 支持属性引用方式的版本号解析 (如 ${version})
- 自动下载传递依赖
- 使用阿里云Maven镜像，提供更快的下载速度
- 保持Maven仓库的目录结构

## 使用方法

1. 确保已安装Node.js环境
2. 克隆本仓库
3. 安装依赖: `npm install`
4. 运行: `node main.js`
5. 输入pom.xml文件的路径
6. 等待下载完成
7. 查看输出结果

