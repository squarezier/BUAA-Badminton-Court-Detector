'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function invoke(action, value) {
  return ipcRenderer.invoke(`courtwatch:${action}`, value).then(result => {
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });
}

contextBridge.exposeInMainWorld('courtWatch', Object.freeze({
  state: () => invoke('state'),
  onState: callback => {
    const receive = (_event, state) => callback(state);
    ipcRenderer.on('courtwatch:state', receive);
    return () => ipcRenderer.removeListener('courtwatch:state', receive);
  },
  login: () => invoke('login'),
  logOut: () => invoke('log-out'),
  openVenue: id => invoke('open-venue', id),
  start: () => invoke('start'),
  pause: () => invoke('pause'),
  saveOptions: options => invoke('options', options),
  saveToken: token => invoke('token', token),
  testPush: () => invoke('push-test'),
  pushGuide: () => invoke('push-guide'),
  pushSetup: () => invoke('push-setup'),
}));
