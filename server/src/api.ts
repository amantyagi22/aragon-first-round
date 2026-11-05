import { createApp } from './app.js';
import { ensureBucket } from './s3.js';

await ensureBucket();
const port = Number(process.env.PORT ?? 4000);
createApp().listen(port, () => console.log(`api listening on :${port}`));
