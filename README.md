# YouTube Music Force Pure Audio

一个用于 [YouTube Music 网页端](https://music.youtube.com/) 的油猴脚本，用来解决听歌时经常被自动替换成 MV 版本的问题。

## 解决的问题

在 YouTube Music 播放歌单或电台时，很多明明有专辑纯享音频的歌，会被自动切到官方 MV 版本（带剧情前奏、杂音或不同的混音版本）。

安装这个脚本后，会自动把播放队列里的 MV 匹配并替换回对应的专辑纯音频版本，同时同步更新对应的专辑封面与歌曲信息。如果某首歌本身没有纯音频版本，则会正常播放原视频。

## 使用方法

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/) 扩展。
2. 将仓库中的 [`ytmusic_force_pure_audio_user.js`](./ytmusic_force_pure_audio_user.js) 导入扩展中启用。
3. 打开 [YouTube Music](https://music.youtube.com/) 即可。
