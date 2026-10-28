import {createScheduleTool} from './tool.mjs';

export default function scheduleExtension(pi) {
  pi.registerTool(createScheduleTool());
}
