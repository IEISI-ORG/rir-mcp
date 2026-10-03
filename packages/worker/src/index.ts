export { StateDO } from './state-do';

export default {
  async fetch(): Promise<Response> {
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
