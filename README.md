![banner](./.github/banner.png)

<h1 align='center'>
cartcut
</h1>

<p align='center'>
Opensource alternative to capcut
</p>

![plot](./.github/screenshotv1.png)

<p align='center'>

<a href="#"><img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/cartesiancs/nugget-app?style=for-the-badge" /></a>
&nbsp;
<a href="#"><img alt="GitHub Repo stars" src="https://img.shields.io/github/license/cartesiancs/nugget-app?style=for-the-badge" /></a>
&nbsp;
<img alt="GitHub Release" src="https://img.shields.io/github/v/release/cartesiancs/nugget-app?style=for-the-badge">

</p>

#

<p align='center'>
English | <a href="./docs/README.ko.md">한국어</a>
</p>

<p align='center'>
<a href="https://www.youtube.com/watch?v=Bh06VOYSMIM">View Demo</a> · <a href="https://github.com/cartesiancs/nugget-app/issues">Report Bugs</a> · <a href="https://github.com/cartesiancs/nugget-app/releases"><b>Download</b></a> · <a href="https://github.com/cartesiancs/nugget-app/issues/new">Suggest Features </a>
</p>

#

Video editing software designed for motion effects and versatility.

In addition to essential features like basic cut editing, animation, sound mixing, external library extensions, project management, and text editing, our software offers a wide range of powerful tools.

It also supports layer-based editing, which differs from traditional track-based editing. This approach makes it easier to apply multiple effects to individual assets, providing greater flexibility and creative control.

> [!IMPORTANT]
> 📢 <strong>Currently, the 0.4.x version is being refactored.</strong> It can be a little unstable.

## About The Project

https://github.com/user-attachments/assets/922a8a7d-ec58-4141-bb4a-5b016da268a8

_This video is made of Cartcut._

You can check out a limited demo of the website at the [following link](https://demo.nugget.cartesiancs.com/).

## Features

- Cut Edit
- Support for all standard formats (mp4, mov, mp3, wav...)
- Audio mixing
- Fast rendering with FFmpeg
- Unlimited layers
- Cross Platform
- Re-position, Scale, Opacity, Rotation animation, Keyframe
- Add Text
- External Extension
- Save&Load Project as File
- Multilingual Support
- 8k Edit & 4k Edit & more resolution
- Screen Record & Audio Record
- Chromakey
- AI Auto Caption (whisper)
- Blur Effect (WebGL)
- GIF Api
- Draw shape
- and more...

## Installation

First, install dependencies.

```
npm install
```

and, **Download** ffmpeg and ffprobe into the "./bin" folder. There's a version for Mac and a version for Windows separately. Compatible binary files can be downloaded from https://github.com/cartesiancs/ffmpeg4nugget

next, **Permission** grant is required. Please enter the command below to grant permission for bin folder.

`chmod -R 777 bin`

## Running

```
npm run dev
npm run start
```

## Roadmap

Our ultimate goal is to empower creators to produce motion graphics effortlessly. We hope they can achieve stunning motion effects without relying on heavy software like After Effects.

Please refer to the [roadmap file](./docs/ROADMAP.md) for more details.

## Contributors

 <a href = "https://github.com/cartesiancs/nugget-app/graphs/contributors">
   <img src = "https://contrib.rocks/image?repo=cartesiancs/nugget-app"/>
 </a>

## License

We are adopting the MIT license. [license file](./LICENSE)
