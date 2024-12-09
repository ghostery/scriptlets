# Scriptlets for Ghostery Tracker & Ad Blocker

To update scriptlets run the following procedure:
* update package.json build script with a `--tagName` of desired version of [uBO release](https://github.com/gorhill/uBlock/releases)
* run `npm run build`
* verify correctless by running `npm test`
* commit and push to github
