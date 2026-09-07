// Run with playwright-cli run-code --filename scripts/desktop-ux-browser-setup.js.
// This exercises the real desktop UI with an explicit, in-memory IPC substitute;
// it never reads, renames, deletes, or pairs actual user files/devices.
async (page) => {
  await page.unrouteAll();
  await page.route("**/src.tsx*", async (route) => {
    const response = await route.fetch();
    const setup = `
      import { mockIPC } from '/@fs/C:/Users/user/Documents/easydoc/node_modules/@tauri-apps/api/mocks.js';
      import { emit } from '/@fs/C:/Users/user/Documents/easydoc/node_modules/@tauri-apps/api/event.js';
      window.__uxMock = {
        settings: {desktopAlias:'테스트 PC', receiveDir:'C:/EasyDoc-QA',paired:true,pairedCount:1,connected:true},
        items: [{filename:'테스트.pdf',path:'C:/EasyDoc-QA/테스트.pdf',size:1024,arrivedAt:Date.now(),status:'completed'}],
        devices: [{roomId:'qa-room',deviceId:'qa-pc',mobileId:'qa-phone',mobileAlias:'테스트 휴대폰',authorized:true,connected:true}],
        calls: [], failures: {}, delays: {}, pending: {}, maxPending: {},
        change: section => emit('easydoc:changed',{section}),
      };
      mockIPC(async (command, args) => {
        const mock = window.__uxMock;
        mock.calls.push({command,args});
        mock.pending[command] = (mock.pending[command] || 0) + 1;
        mock.maxPending[command] = Math.max(mock.maxPending[command] || 0, mock.pending[command]);
        try {
          if (mock.delays[command]) await new Promise(resolve => setTimeout(resolve, mock.delays[command]));
          if (mock.failures[command]) throw new Error(mock.failures[command]);
          if(command==='get_settings') return {...mock.settings};
          if(command==='list_inbox') return mock.items.map(item=>({...item}));
          if(command==='list_pairings') return mock.devices.map(item=>({...item}));
          if(command==='set_desktop_alias') {mock.settings.desktopAlias=args.desktopAlias;return {...mock.settings};}
          if(command==='rename_file') {const item=mock.items.find(item=>item.path===args.path);item.filename=args.newName;return {...item};}
          if(command==='delete_file') {mock.items=mock.items.filter(item=>item.path!==args.path);return;}
          if(command==='set_pairing_label') {mock.devices[0].mobileAlias=args.mobileAlias;return mock.devices;}
          if(command==='create_pairing') return {qrPayload:'easydoc://pair?qa=1',roomId:'qa-new'};
          if(command==='choose_receive_dir') return null;
          if(command==='revoke_pairing') {mock.devices=[];return [];}
        } finally {mock.pending[command]--;}
      }, {shouldMockEvents:true});
    `;
    await route.fulfill({ response, body: setup + await response.text() });
  });
  await page.reload();
  await page.getByRole("textbox", { name: /이 PC 이름/ }).waitFor();
  console.log("Real desktop UI loaded with in-memory IPC; no user data is modified.");
}
