import { contextBridge, ipcRenderer } from 'electron';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type Api,
  type EventChannelName,
  type EventPayload,
  type InvokeChannelName,
  type InvokeReq,
  type InvokeRes
} from '../shared/ipc';

const invokeSet = new Set<string>(INVOKE_CHANNELS);
const eventSet = new Set<string>(EVENT_CHANNELS);

const api: Api = {
  invoke<C extends InvokeChannelName>(channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>> {
    if (!invokeSet.has(channel)) {
      return Promise.reject(new Error(`Unknown invoke channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, req) as Promise<InvokeRes<C>>;
  },
  on<C extends EventChannelName>(channel: C, listener: (payload: EventPayload<C>) => void) {
    if (!eventSet.has(channel)) {
      throw new Error(`Unknown event channel: ${channel}`);
    }
    const wrapped = (_e: unknown, payload: EventPayload<C>): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
};

contextBridge.exposeInMainWorld('api', api);
