const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const https = require('https');
const { mkdirp } = require('mkdirp')
const { SocksProxyAgent } = require('socks-proxy-agent');
const HttpProxyAgent = require('http-proxy-agent');

// Maven阿里云镜像的基础URL
const MAVEN_CENTRAL_URL = 'https://repo.maven.apache.org/maven2';

// 代理配置
const PROXY_CONFIG = {
    // 根据实际情况配置代理
    socks: 'socks5://127.0.0.1:11080', // 例如 'socks5://127.0.0.1:1080'
    // http: process.env.HTTP_PROXY    // 例如 'http://127.0.0.1:8080'
};

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
        console.log('POM对象为空');
        return dependencies;
    }
    
    if (pomObj.project && pomObj.project.dependencies && pomObj.project.dependencies[0].dependency) {
        console.log('找到依赖项部分');
        
        pomObj.project.dependencies[0].dependency.forEach(dep => {
            if (dep.groupId && dep.artifactId && dep.version && dep.version[0]) {
                dependencies.push({
                    groupId: dep.groupId[0],
                    artifactId: dep.artifactId[0],
                    version: dep.version[0]
                });
                console.log('处理依赖项:', {
                    groupId: dep.groupId[0],
                    artifactId: dep.artifactId[0],
                    version: dep.version[0]
                });
            } else {
                console.warn('跳过无效依赖项:', dep);
            }
        });
    } else {
        console.log('未找到依赖项或POM结构无效');
    }
    
    return dependencies;
}

// 下载依赖
async function downloadDependency(dependency, repositoryPath) {
    const { groupId, artifactId, version } = dependency;
    
    // 验证所有必需字段
    if (!groupId || !artifactId || !version) {
        console.warn('跳过无效依赖:', dependency);
        return;
    }
    
    const artifactPath = groupId.replace(/\./g, '/') + '/' + artifactId + '/' + version;
    const jarName = `${artifactId}-${version}.jar`;
    const pomName = `${artifactId}-${version}.pom`;
    
    const localPath = path.join(repositoryPath, artifactPath);
    await mkdirp(localPath);

    try {
        // 下载jar文件
        console.log(`开始下载JAR: ${MAVEN_CENTRAL_URL}/${artifactPath}/${jarName}`);
        await downloadFile(
            `${MAVEN_CENTRAL_URL}/${artifactPath}/${jarName}`,
            path.join(localPath, jarName)
        );
        console.log(`JAR下载完成: ${jarName}`);

        // 下载pom文件以获取传递依赖
        const pomFilePath = path.join(localPath, pomName);
        console.log(`开始下载POM: ${MAVEN_CENTRAL_URL}/${artifactPath}/${pomName}`);
        await downloadFile(
            `${MAVEN_CENTRAL_URL}/${artifactPath}/${pomName}`,
            pomFilePath
        );
        console.log(`POM下载完成: ${pomName}`);

        // 检查下载的pom文件是否为空或不存在
        if (!fs.existsSync(pomFilePath)) {
            console.error(`POM文件不存在: ${pomName}`);
            return;
        }
        const stats = fs.statSync(pomFilePath);
        if (stats.size === 0) {
            console.error(`下载的POM文件为空: ${pomName}`);
            fs.unlinkSync(pomFilePath);
            return;
        }

        // 解析下载的pom文件获取传递依赖
        try {
            const depPomObj = await parsePomXml(pomFilePath);
            if (depPomObj) {
                const transitiveDeps = getDependencies(depPomObj);
                
                // 递归下载传递依赖
                for (const dep of transitiveDeps) {
                    await downloadDependency(dep, repositoryPath);
                }
            }
        } catch (err) {
            console.error(`处理传递依赖时出错 ${jarName}:`, err);
        }
    } catch (err) {
        console.error(`下载依赖时出错 ${jarName}:`, err.message);
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
            }
        };

        // 配置代理
        if (PROXY_CONFIG.socks) {
            options.agent = new SocksProxyAgent(PROXY_CONFIG.socks);
        } else if (PROXY_CONFIG.http) {
            options.agent = new HttpProxyAgent(PROXY_CONFIG.http);
        }

        https.get(url, options, response => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                const redirectUrl = response.headers.location;
                console.log(`重定向到: ${redirectUrl}`);
                file.close();
                fs.unlink(dest, () => {});
                
                https.get(redirectUrl, options, redirectResponse => {
                    if (redirectResponse.statusCode === 404) {
                        console.error(`未找到文件: ${redirectUrl}`);
                        file.close();
                        fs.unlink(dest, () => {});
                        reject(new Error('文件未找到'));
                        return;
                    }

                    if (redirectResponse.statusCode !== 200) {
                        console.error(`下载失败，状态码: ${redirectResponse.statusCode}, URL: ${redirectUrl}`);
                        file.close();
                        fs.unlink(dest, () => {});
                        reject(new Error(`HTTP状态码 ${redirectResponse.statusCode}`));
                        return;
                    }

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
                console.error(`未找到文件: ${url}`);
                file.close();
                fs.unlink(dest, () => {});
                reject(new Error('文件未找到'));
                return;
            }

            if (response.statusCode !== 200) {
                console.error(`下载失败，状态码: ${response.statusCode}, URL: ${url}`);
                file.close();
                fs.unlink(dest, () => {});
                reject(new Error(`HTTP状态码 ${response.statusCode}`));
                return;
            }
            
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
        
        console.log('开始解析pom.xml...');
        const pomObj = await parsePomXml(pomPath);
        
        console.log('获取依赖列表...');
        const dependencies = getDependencies(pomObj);
        
        console.log('开始下载依赖...');
        for (const dep of dependencies) {
            if (dep.version) {
                console.log(`正在下载 ${dep.groupId}:${dep.artifactId}:${dep.version}`);
                await downloadDependency(dep, repositoryPath);
            } else {
                console.warn(`跳过未定义版本的依赖: ${dep.groupId}:${dep.artifactId}`);
            }
        }
        
        console.log('所有依赖项下载完成！');
    } catch (err) {
        console.error('程序执行出错:', err);
        process.exit(1);
    }
}

// 运行程序
main();
