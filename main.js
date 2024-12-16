const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const https = require('https');
const { mkdirp } = require('mkdirp')

// Maven阿里云镜像的基础URL
const MAVEN_CENTRAL_URL = 'https://maven.aliyun.com/repository/public';

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
    
    console.log('正在解析POM对象:', JSON.stringify(pomObj, null, 2));
    
    if (pomObj.project && pomObj.project.dependencies && pomObj.project.dependencies[0].dependency) {
        console.log('找到依赖项部分');
        
        pomObj.project.dependencies[0].dependency.forEach(dep => {
            console.log('正在处理依赖项:', dep);
            if (dep.groupId && dep.artifactId && dep.version && dep.version[0]) {
                dependencies.push({
                    groupId: dep.groupId[0],
                    artifactId: dep.artifactId[0],
                    version: dep.version[0]
                });
                console.log('已添加依赖项:', {
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
    
    console.log('最终依赖项列表:', dependencies);
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
        await downloadFile(
            `${MAVEN_CENTRAL_URL}/${artifactPath}/${jarName}`,
            path.join(localPath, jarName)
        );

        // 下载pom文件以获取传递依赖
        await downloadFile(
            `${MAVEN_CENTRAL_URL}/${artifactPath}/${pomName}`,
            path.join(localPath, pomName)
        );

        // 解析下载的pom文件获取传递依赖
        try {
            const depPomObj = await parsePomXml(path.join(localPath, pomName));
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
        console.error(`下载依赖时出错 ${jarName}:`, err);
    }
}

// 下载文件的辅助函数
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, response => {
            if (response.statusCode === 404) {
                console.warn(`未找到文件: ${url}`);
                file.close();
                fs.unlink(dest, () => {});
                resolve();
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
        
        // 解析pom.xml
        const pomObj = await parsePomXml(pomPath);
        
        // 获取所有依赖
        const dependencies = getDependencies(pomObj);
        
        // 下载所有依赖
        for (const dep of dependencies) {
            if (dep.version) {
                console.log(`正在下载 ${dep.groupId}:${dep.artifactId}:${dep.version}`);
                await downloadDependency(dep, repositoryPath);
            } else {
                console.warn(`跳过未定义版本的依赖: ${dep.groupId}:${dep.artifactId}`);
            }
        }
        
        console.log('所有依赖项下载成功！');
    } catch (err) {
        console.error('错误:', err);
    }
}

// 运行程序
main();
