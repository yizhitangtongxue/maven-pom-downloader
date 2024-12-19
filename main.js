const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const https = require('https');
const { mkdirp } = require('mkdirp')
const { SocksProxyAgent } = require('socks-proxy-agent');
const HttpProxyAgent = require('http-proxy-agent');
const cliProgress = require('cli-progress');

// Maven镜像的基础URL - 使用Maven中央仓库
const MAVEN_CENTRAL_URL = 'https://repo1.maven.org/maven2';

// 代理配置
const PROXY_CONFIG = {
    enabled: true, // 是否启用代理
    socks: 'socks5://127.0.0.1:11080', // 例如 'socks5://127.0.0.1:1080'
    http: null // 例如 'http://127.0.0.1:8080'
};

// 并发下载配置
const CONCURRENT_DOWNLOADS = 5; // 同时下载的最大数量

// 用于记录已下载的依赖
const downloadedDependencies = new Set();

// 创建日志文件流
const logStream = fs.createWriteStream('maven-download.log', { flags: 'a' });

// 日志函数
function log(message, ...args) {
    const now = new Date();
    const timestamp = now.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const logMessage = `[${timestamp}] ${message} ${args.join(' ')}\n`;
    logStream.write(logMessage);
}

// 解析版本号
function resolveVersion(version, properties) {
    if (!version) return null;
    
    // 如果版本号是以 ${} 形式的属性引用
    if (version.startsWith('${') && version.endsWith('}')) {
        const propertyName = version.slice(2, -1); // 移除 ${ 和 }
        
        if (properties) {
            // 直接查找属性
            if (properties[propertyName]) {
                return properties[propertyName][0];
            }
            
            // 处理带点的属性名 (如 commons.lang.version)
            const parts = propertyName.split('.');
            let current = properties;
            for (const part of parts) {
                if (current[part] && current[part][0]) {
                    current = current[part][0];
                } else {
                    return null; // 如果找不到属性，返回null
                }
            }
            return current;
        }
    }
    
    // 处理版本范围格式
    if (version.includes('[') && version.includes(']') || version.includes('(') || version.includes(')')) {
        const versionRange = parseVersionRange(version);
        return versionRange.min || version; // 暂时使用范围中的最小版本
    }
    
    return version;
}

// 解析pom.xml文件
async function parsePomXml(pomPath) {
    const parser = new xml2js.Parser();
    const pomContent = fs.readFileSync(pomPath, 'utf-8');
    return new Promise((resolve, reject) => {
        parser.parseString(pomContent, (err, result) => {
            if (err) {
                reject(err);
            } else {
                // 检查result是否为null或undefined
                if (!result) {
                    resolve(null);
                    return;
                }
                
                // 预处理properties
                const properties = result.project?.properties?.[0] || {};
                
                // 预处理所有依赖的版本号
                if (result.project?.dependencies?.[0]?.dependency) {
                    result.project.dependencies[0].dependency = 
                        result.project.dependencies[0].dependency.map(dep => ({
                            ...dep,
                            version: dep.version ? [resolveVersion(dep.version[0], properties)] : []
                        }));
                }
                resolve(result);
            }
        });
    });
}

// 获取所有依赖
function getDependencies(pomObj) {
    const dependencies = [];
    if (!pomObj) {
        log('POM对象为空');
        return dependencies;
    }
    
    if (pomObj.project && pomObj.project.dependencies && pomObj.project.dependencies[0].dependency) {
        log('找到依赖项部分');
        
        pomObj.project.dependencies[0].dependency.forEach(dep => {
            if (dep.groupId && dep.artifactId && dep.version && dep.version[0]) {
                dependencies.push({
                    groupId: dep.groupId[0],
                    artifactId: dep.artifactId[0],
                    version: dep.version[0]
                });
                log('处理依赖项:', JSON.stringify({
                    groupId: dep.groupId[0],
                    artifactId: dep.artifactId[0],
                    version: dep.version[0]
                }));
            } else {
                log('跳过无效依赖项:', JSON.stringify(dep));
            }
        });
    } else {
        log('未找到依赖项或POM结构无效');
    }
    
    return dependencies;
}

// 下载依赖
async function downloadDependency(dependency, repositoryPath) {
    const { groupId, artifactId, version } = dependency;
    
    // 验证所有必需字段
    if (!groupId || !artifactId || !version) {
        log('跳过无效依赖:', JSON.stringify(dependency));
        return;
    }

    // 检查是否已下载过该依赖
    const dependencyKey = `${groupId}:${artifactId}:${version}`;
    if (downloadedDependencies.has(dependencyKey)) {
        log(`依赖已处理过，跳过: ${dependencyKey}`);
        return;
    }
    
    // 标记该依赖为已下载
    downloadedDependencies.add(dependencyKey);
    
    // 处理版本范围
    let actualVersion = version;
    if (version.includes('[') || version.includes('(')) {
        const versionRange = parseVersionRange(version);
        actualVersion = versionRange.min;
        log(`版本范围 ${version} 使用最小版本: ${actualVersion}`);
    }
    
    const artifactPath = groupId.replace(/\./g, '/') + '/' + artifactId + '/' + actualVersion;
    const jarName = `${artifactId}-${actualVersion}.jar`;
    const pomName = `${artifactId}-${actualVersion}.pom`;
    
    const localPath = path.join(repositoryPath, artifactPath);
    await mkdirp(localPath);

    const localJarPath = path.join(localPath, jarName);
    const pomFilePath = path.join(localPath, pomName);

    try {
        const downloadTasks = [];

        // 检查jar文件是否已存在
        if (!fs.existsSync(localJarPath)) {
            const jarUrl = `${MAVEN_CENTRAL_URL}/${artifactPath}/${jarName}`;
            log(`开始下载JAR: ${jarUrl}`);
            downloadTasks.push(downloadFile(jarUrl, localJarPath));
        } else {
            log(`JAR文件已存在，跳过下载: ${jarName}`);
        }

        // 检查pom文件是否已存在
        if (!fs.existsSync(pomFilePath)) {
            const pomUrl = `${MAVEN_CENTRAL_URL}/${artifactPath}/${pomName}`;
            log(`开始下载POM: ${pomUrl}`);
            downloadTasks.push(downloadFile(pomUrl, pomFilePath));
        } else {
            log(`POM文件已存在，跳过下载: ${pomName}`);
        }

        // 并行下载jar和pom文件
        if (downloadTasks.length > 0) {
            await Promise.all(downloadTasks);
        }

        // 检查下载的pom文件是否为空或不存在
        if (!fs.existsSync(pomFilePath)) {
            log(`POM文件不存在: ${pomName}`);
            return;
        }
        const stats = fs.statSync(pomFilePath);
        if (stats.size === 0) {
            log(`下载的POM文件为空: ${pomName}`);
            fs.unlinkSync(pomFilePath);
            return;
        }

        // 解析下载的pom文件获取传递依赖
        try {
            const depPomObj = await parsePomXml(pomFilePath);
            if (depPomObj) {
                const transitiveDeps = getDependencies(depPomObj);
                
                // 并发下载传递依赖
                const chunks = [];
                for (let i = 0; i < transitiveDeps.length; i += CONCURRENT_DOWNLOADS) {
                    chunks.push(transitiveDeps.slice(i, i + CONCURRENT_DOWNLOADS));
                }

                for (const chunk of chunks) {
                    await Promise.all(chunk.map(dep => downloadDependency(dep, repositoryPath)));
                }
            }
        } catch (err) {
            log(`处理传递依赖时出错 ${jarName}:`, err.toString());
        }
    } catch (err) {
        log(`下载依赖时出错 ${jarName}:`, err.message);
    }
}

// 下载文件的辅助函数
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': '*/*'
            },
            timeout: 10000 // 设置10秒超时
        };

        // 配置代理
        if (PROXY_CONFIG.enabled) {
            if (PROXY_CONFIG.socks) {
                options.agent = new SocksProxyAgent(PROXY_CONFIG.socks);
            } else if (PROXY_CONFIG.http) {
                options.agent = new HttpProxyAgent(PROXY_CONFIG.http);
            }
        }

        https.get(url, options, response => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                const redirectUrl = response.headers.location;
                log(`重定向到: ${redirectUrl}`);
                file.close();
                fs.unlink(dest, () => {});
                
                https.get(redirectUrl, options, redirectResponse => {
                    if (redirectResponse.statusCode === 404) {
                        log(`未找到文件: ${redirectUrl}`);
                        file.close();
                        fs.unlink(dest, () => {});
                        reject(new Error('文件未找到'));
                        return;
                    }

                    if (redirectResponse.statusCode !== 200) {
                        log(`下载失败，状态码: ${redirectResponse.statusCode}, URL: ${redirectUrl}`);
                        file.close();
                        fs.unlink(dest, () => {});
                        reject(new Error(`HTTP状态码 ${redirectResponse.statusCode}`));
                        return;
                    }

                    const totalSize = parseInt(redirectResponse.headers['content-length'], 10);
                    let downloadedSize = 0;

                    redirectResponse.on('data', (chunk) => {
                        downloadedSize += chunk.length;
                    });

                    redirectResponse.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        resolve();
                    });
                }).on('error', err => {
                    fs.unlink(dest, () => {});
                    reject(err);
                });
                return;
            }

            if (response.statusCode === 404) {
                log(`未找到文件: ${url}`);
                file.close();
                fs.unlink(dest, () => {});
                reject(new Error('文件未找到'));
                return;
            }

            if (response.statusCode !== 200) {
                log(`下载失败，状态码: ${response.statusCode}, URL: ${url}`);
                file.close();
                fs.unlink(dest, () => {});
                reject(new Error(`HTTP状态码 ${response.statusCode}`));
                return;
            }
            
            const totalSize = parseInt(response.headers['content-length'], 10);
            let downloadedSize = 0;
            
            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
            });
            
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', err => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

// 主函数
async function main() {
    try {
        const pomPath = './pom.xml';
        const repositoryPath = './repository';
        
        // 确保repository文件夹存在
        await mkdirp(repositoryPath);
        
        // 提示代理配置
        if (PROXY_CONFIG.enabled) {
            if (PROXY_CONFIG.socks) {
                log(`使用SOCKS代理: ${PROXY_CONFIG.socks}`);
            } else if (PROXY_CONFIG.http) {
                log(`使用HTTP代理: ${PROXY_CONFIG.http}`);
            }
        }
        
        const pomObj = await parsePomXml(pomPath);
        const dependencies = getDependencies(pomObj);
        
        const totalDeps = dependencies.length;
        const progressBar = new cliProgress.SingleBar({
            format: '下载进度 |{bar}| {percentage}% | {value}/{total} | {currentDep}',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591'
        });
        progressBar.start(totalDeps, 0, {
            currentDep: '准备开始'
        });

        // 并发下载依赖
        const chunks = [];
        for (let i = 0; i < dependencies.length; i += CONCURRENT_DOWNLOADS) {
            chunks.push(dependencies.slice(i, i + CONCURRENT_DOWNLOADS));
        }

        let completedCount = 0;
        for (const chunk of chunks) {
            await Promise.all(chunk.map(async dep => {
                if (dep.version) {
                    const currentDep = `${dep.groupId}:${dep.artifactId}:${dep.version}`;
                    await downloadDependency(dep, repositoryPath);
                    completedCount++;
                    progressBar.update(completedCount, { currentDep });
                }
            }));
        }
        
        progressBar.stop();
    } catch (err) {
        log('程序执行出错:', err.toString());
        process.exit(1);
    }
}

// 运行程序
main();

// 版本范围解析函数
function parseVersionRange(versionRange) {
    // 移除所有空格
    versionRange = versionRange.trim();
    
    // 处理 [x.x,) 格式 - 表示大于等于某版本
    if (versionRange.startsWith('[') && versionRange.endsWith(')')) {
        const minVersion = versionRange.slice(1, -2);
        return {
            min: minVersion,
            includeMin: true,
            max: null,
            includeMax: false
        };
    }
    
    // 如果是具体版本号，直接返回
    return {
        exact: versionRange
    };
}
