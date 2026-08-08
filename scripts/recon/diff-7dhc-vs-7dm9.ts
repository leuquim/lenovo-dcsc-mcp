import { readFileSync } from 'node:fs';

function main() {
  const dhcXml = readFileSync('artifacts/nvidia_ai_factory_blueprints/nvidia-blueprint-7dhccto1ww.xml', 'utf8');
  const dm9Xml = readFileSync('artifacts/nvidia_ai_factory_blueprints/nvidia-blueprint-7dm9cto1ww.xml', 'utf8');

  console.log('=== 7DHC (SR685a V3 AMD) Header Snippet ===');
  console.log(dhcXml.slice(0, 1500));

  console.log('\n=== 7DM9 (SR680a V3 Intel) Header Snippet ===');
  console.log(dm9Xml.slice(0, 1500));
}

main();
