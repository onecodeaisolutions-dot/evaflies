// Seleciona a implementação de storage conforme a configuração:
// Supabase (Postgres) quando configurado, senão arquivo JSON local.
import { useSupabase } from './storage-config.js';
import * as fileStore from './store-file.js';
import * as supaStore from './store-supabase.js';

const impl = useSupabase ? supaStore : fileStore;

export const initStore = (...a) => impl.initStore(...a);
export const ping = (...a) => impl.ping(...a);
export const listMeetings = (...a) => impl.listMeetings(...a);
export const getMeeting = (...a) => impl.getMeeting(...a);
export const createMeeting = (...a) => impl.createMeeting(...a);
export const updateMeeting = (...a) => impl.updateMeeting(...a);
export const deleteMeeting = (...a) => impl.deleteMeeting(...a);
