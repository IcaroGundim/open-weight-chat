import { app } from '../src/server/index';

/** Tempo para modelos de raciocínio e respostas longas com streaming. */
export const maxDuration = 300;

export default {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request);
  },
};
