const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
module.exports = async ({ app, win, lib, connectors }) => {
  try {
    const js = (s) => win.webContents.executeJavaScript(s);
    await connectors.qq();
    assert.equal(lib.data.connectors.qq.status, 'ready');
    assert.ok(lib.data.items.filter((i) => i.source === 'QQ').length >= 192);
    assert.ok(lib.data.items.filter((i) => i.animated).length >= 80);
    await js('document.querySelector("#manage").click()');
    assert.equal(await js('document.querySelectorAll(".connector").length'), 3);
    assert.match(await js('document.querySelector("#connector-list").textContent'), /本次新增 \d+/);
    const before = lib.data.items.length;
    await connectors.qq();
    assert.ok(lib.data.items.length >= before);
    await new Promise((r) => setTimeout(r, 400));
    await fs.mkdir(process.env.STICKER_EVIDENCE, { recursive: true });
    await fs.writeFile(
      path.join(process.env.STICKER_EVIDENCE, 'connectors.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js('document.querySelector("#settings .close").click()');
    await fs.writeFile(
      path.join(process.env.STICKER_EVIDENCE, 'qq-library.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    console.log(
      JSON.stringify({
        passed: true,
        qqOriginals: before,
        animated: lib.data.items.filter((i) => i.animated).length,
        secondScanAdded: lib.data.items.length - before,
      }),
    );
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
};
