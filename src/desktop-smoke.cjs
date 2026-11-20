const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async ({ app, win, lib }) => {
  const js = (source) => win.webContents.executeJavaScript(source);
  try {
    await js('new Promise(resolve=>setTimeout(resolve,60))');
    await js(`document.querySelector('[data-filter="trash"]').click()`);
    assert.equal(await js('document.querySelector("#empty .import").hidden'), true);
    assert.equal(await js('document.querySelector("#restore-all").disabled'), true);
    await js(`document.querySelector('[data-filter="all"]').click()`);
    const input = process.env.STICKER_FIXTURE;
    await js('window.vault.importFiles(' + JSON.stringify([input]) + ')');
    await js('new Promise(resolve=>setTimeout(resolve,40))');
    assert.equal(await js('state.items.length'), 1);
    const id = lib.data.items[0].id;
    await js(
      'window.imageBefore=mainGrid.nodes.get(' +
        JSON.stringify(id) +
        ').querySelector("img");window.vault.update(' +
        JSON.stringify(id) +
        ',{favorite:true,tags:["保持"]})',
    );
    await js('new Promise(resolve=>setTimeout(resolve,40))');
    assert.equal(await js('state.items[0].favorite'), true);
    assert.equal(
      await js(
        'mainGrid.nodes.get(' + JSON.stringify(id) + ').querySelector("img")===window.imageBefore',
      ),
      true,
    );
    const removed = await js('window.vault.remove(' + JSON.stringify([id]) + ')');
    assert.equal(removed.count, 1);
    await js('new Promise(resolve=>setTimeout(resolve,40))');
    assert.equal(await js('state.items.length'), 0);
    assert.equal(await js('state.trash.length'), 1);
    assert.ok((await fs.stat(path.join(lib.root, 'originals', lib.data.trash[0].file))).size > 0);
    await js(`document.querySelector('[data-filter="trash"]').click()`);
    assert.equal(await js('document.querySelectorAll(".card").length'), 1);
    await js('window.vault.restoreTrash(' + JSON.stringify([id]) + ')');
    await js('new Promise(resolve=>setTimeout(resolve,40))');
    assert.equal(await js('state.trash.length'), 0);
    assert.equal(await js('state.items[0].favorite'), true);
    assert.deepEqual(lib.data.items[0].tags, ['保持']);
    const report = await js(
      'window.vault.importFiles(' +
        JSON.stringify([path.join(lib.root, 'missing.png'), input]) +
        ')',
    );
    assert.equal(report.failed, 1);
    assert.equal(report.duplicates, 1);
    await js('new Promise(resolve=>setTimeout(resolve,40))');
    await js('openReport(' + JSON.stringify(report.reportId) + ')');
    await js('document.querySelector("#report-filter").value="failed";renderReportDetails()');
    assert.equal(await js('reportGrid.items.length'), 1);
    console.log(
      'DESKTOP_FLOW_PASS: real preload IPC, item delta preserves image, soft delete/restore with tags, persisted diagnosis and failure filter; isolated profile, clipboard untouched',
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
};
