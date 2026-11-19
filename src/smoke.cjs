const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
module.exports = async ({ app, win, lib, snapshot }) => {
  try {
    const out = process.env.STICKER_EVIDENCE;
    await fs.mkdir(out, { recursive: true });
    const js = (s) => win.webContents.executeJavaScript(s);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await js('document.querySelector("#empty").hidden'), false);
    await fs.writeFile(path.join(out, 'empty.png'), (await win.webContents.capturePage()).toPNG());
    await lib.import([process.env.STICKER_FIXTURES], '本地导入');
    win.webContents.send('changed', snapshot());
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await js('document.querySelectorAll(".card").length'), 6);
    assert.equal(
      await js(
        '[...document.images].filter(i=>i.closest(".card")).every(i=>i.complete&&i.naturalWidth>0)',
      ),
      true,
    );
    await fs.writeFile(
      path.join(out, 'library-wide.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js('document.querySelector("[data-filter=animated]").click()');
    assert.equal(await js('document.querySelectorAll(".card").length'), 3);
    await js(
      'document.querySelector("[data-filter=all]").click();document.querySelector("#search").value="收到";document.querySelector("#search").dispatchEvent(new Event("input"))',
    );
    assert.equal(await js('document.querySelectorAll(".card").length'), 1);
    await js('document.querySelector(".card").click()');
    assert.equal(await js('document.querySelector("#detail").open'), true);
    await js(
      'document.querySelector("#edit-name").value="已收到";document.querySelector("#edit-tags").value="工作, 回复";document.querySelector("#save").click()',
    );
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(lib.data.items.some((i) => i.name === '已收到' && i.tags.includes('工作')));
    await js(
      'document.querySelector("#search").value="";document.querySelector("#search").dispatchEvent(new Event("input"));document.querySelector("#select-mode").click();document.querySelector(".card").click()',
    );
    assert.match(await js('document.querySelector("#selection-count").textContent'), /1/);
    await js('document.querySelector("#cancel-select").click()');
    win.setSize(820, 680);
    await new Promise((r) => setTimeout(r, 250));
    await fs.writeFile(
      path.join(out, 'library-narrow.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    await js('document.querySelector("#manage").click()');
    await fs.writeFile(
      path.join(out, 'settings.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await fs.writeFile(
      path.join(out, 'smoke.json'),
      JSON.stringify(
        {
          passed: true,
          checks: [
            'empty state',
            '6 images decoded',
            '3 animated GIFs detected',
            'search',
            'detail dialog',
            'metadata persistence',
            'multi-select',
            '820px no horizontal overflow',
            'settings dialog',
          ],
          untested: [
            'Native drag into WeChat/QQ/Douyin',
            'Windows/Linux runtime',
            'mobile',
            'account favorites integration',
          ],
        },
        null,
        2,
      ),
    );
    console.log('SMOKE PASSED');
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
};
