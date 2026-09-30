// PropGenie model lineup + provider list prices (USD per 1M tokens), verified 2026-09-01.
// Keep in sync with the PropGenie tokenomics sheet.
export const MODELS = {
  'genie-pro':    { label: 'Genie Pro',    provider: 'OpenAI',    api: 'gpt-5.5',                in: 5.0, out: 30, cached: 0.50, perImage: 0 },
  'genie-flash':  { label: 'Genie Flash',  provider: 'Google',    api: 'gemini-3.5-flash',       in: 1.5, out: 9,  cached: 0.15, perImage: 0 },
  'genie-canvas': { label: 'Genie Canvas', provider: 'OpenAI',    api: 'gpt-image-2',            in: 5.0, out: 30, cached: 1.25, perImage: 0 },
  'genie-vision': { label: 'Genie Vision', provider: 'Google',    api: 'gemini-3.1-flash-image', in: 0.5, out: 0,  cached: 0,    perImage: 0.067 },
  'webbuilder':   { label: 'WebBuilder',   provider: 'Anthropic', api: 'claude-sonnet-4.6',      in: 3.0, out: 15, cached: 0.30, perImage: 0 },
};

export const TOOLS = [
  'Social Post Writer', 'Caption Generator', 'Ad Copy Studio', 'Email Campaign Writer',
  'Competitor Insights', 'Image Creator', 'Banner Studio', 'WebBuilder – Page Update', 'WebBuilder – Full Page',
];

// Billing assumptions: 1 credit = $0.01 retail, 5x markup on API cost, credits rounded up per action.
export const CREDIT_VALUE = 0.01;
export const MARKUP = 5;

export function costOf(model, { input_tokens = 0, output_tokens = 0, cached_tokens = 0, images = 0 }) {
  const p = MODELS[model];
  if (!p) throw new Error(`Unknown model: ${model}`);
  return (input_tokens * p.in + output_tokens * p.out + cached_tokens * p.cached) / 1e6 + images * p.perImage;
}

export const creditsFor = (cost) => Math.ceil((cost * MARKUP) / CREDIT_VALUE - 1e-9);
