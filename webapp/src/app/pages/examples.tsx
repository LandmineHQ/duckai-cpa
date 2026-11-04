import { useMemo, useState } from 'react';
import { KeyRound, Terminal } from 'lucide-react';
import { gatewayOrigin } from '@/app/lib/format';
import { PageHeader } from '@/app/components/page-header';
import { CopyButton } from '@/app/components/copy-button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type ExampleTab = 'curl' | 'python' | 'node' | 'responses';

const API_KEY_PLACEHOLDER = 'sk-duck-REPLACE_ME';

const TAB_LABELS: Record<ExampleTab, string> = {
  curl: 'cURL',
  python: 'OpenAI Python SDK',
  node: 'OpenAI Node SDK',
  responses: 'Responses API'
};

function buildExample(tab: ExampleTab, origin: string): string {
  const base = `${origin}/v1`;
  if (tab === 'curl') {
    return [
      '# 所有 /v1/* 请求都必须携带 API Key（v2 强制鉴权）',
      '# 先在管理后台「API Key」页创建/复制 Key，或使用首次启动自动创建的 default key',
      '',
      '# 1) 模型列表（含免费/付费标记）',
      `curl ${base}/models \\`,
      `  -H "Authorization: Bearer ${API_KEY_PLACEHOLDER}"`,
      '',
      '# 2) 非流式对话',
      `curl ${base}/chat/completions \\`,
      '  -H "Content-Type: application/json" \\',
      `  -H "Authorization: Bearer ${API_KEY_PLACEHOLDER}" \\`,
      `  -d '{"model":"gpt-6-luna","messages":[{"role":"user","content":"你好，用三句话介绍你自己"}]}'`,
      '',
      '# 3) 流式对话 + 联网搜索',
      `curl -N ${base}/chat/completions \\`,
      '  -H "Content-Type: application/json" \\',
      `  -H "Authorization: Bearer ${API_KEY_PLACEHOLDER}" \\`,
      `  -d '{"model":"gpt-6-luna","stream":true,"web_search":true,"messages":[{"role":"user","content":"今天有什么科技新闻？"}]}'`,
      '',
      '# 4) 图片生成（返回 b64_json）',
      `curl ${base}/images/generations \\`,
      '  -H "Content-Type: application/json" \\',
      `  -H "Authorization: Bearer ${API_KEY_PLACEHOLDER}" \\`,
      `  -d '{"model":"gpt-6-luna","prompt":"一只戴墨镜的橘猫，扁平插画风"}'`
    ].join('\n');
  }
  if (tab === 'python') {
    return [
      '# pip install openai',
      'import os',
      '',
      'from openai import OpenAI',
      '',
      'client = OpenAI(',
      `    base_url="${base}",`,
      '    api_key=os.environ.get("DUCKAI_CPA_API_KEY", "sk-duck-REPLACE_ME"),',
      ')',
      '',
      '# 非流式对话（v2 强制 API Key）',
      'resp = client.chat.completions.create(',
      '    model="gpt-6-luna",',
      '    messages=[{"role": "user", "content": "用三句话解释什么是 MCP"}],',
      ')',
      'print(resp.choices[0].message.content)',
      '',
      '# 流式对话 + 联网搜索（来源在 annotations 的 url_citation）',
      'stream = client.chat.completions.create(',
      '    model="gpt-6-luna",',
      '    messages=[{"role": "user", "content": "今天有什么科技新闻？"}],',
      '    stream=True,',
      '    extra_body={"web_search": True},',
      ')',
      'for chunk in stream:',
      '    delta = chunk.choices[0].delta.content if chunk.choices else None',
      '    if delta:',
      '        print(delta, end="", flush=True)',
      '',
      '# 图片生成（b64_json）',
      'image = client.images.generate(',
      '    model="gpt-6-luna",',
      '    prompt="一只戴墨镜的橘猫，扁平插画风",',
      '    response_format="b64_json",',
      ')',
      'print(image.data[0].b64_json[:40], "...")'
    ].join('\n');
  }
  if (tab === 'node') {
    return [
      '// npm i openai',
      'import OpenAI from "openai";',
      '',
      'const client = new OpenAI({',
      `  baseURL: "${base}",`,
      '  apiKey: process.env.DUCKAI_CPA_API_KEY || "sk-duck-REPLACE_ME"',
      '});',
      '',
      '// 非流式对话（v2 强制 API Key）',
      'const completion = await client.chat.completions.create({',
      '  model: "gpt-6-luna",',
      '  messages: [{ role: "user", content: "用三句话解释什么是 MCP" }]',
      '});',
      'console.log(completion.choices[0].message.content);',
      '',
      '// 流式 + 联网搜索',
      'const stream = await client.chat.completions.create({',
      '  model: "gpt-6-luna",',
      '  messages: [{ role: "user", content: "今天有什么科技新闻？" }],',
      '  stream: true,',
      '  web_search: true',
      '});',
      'for await (const chunk of stream) {',
      '  const delta = chunk.choices[0]?.delta?.content || "";',
      '  process.stdout.write(delta);',
      '}',
      '',
      '// 图片生成',
      'const image = await client.images.generate({',
      '  model: "gpt-6-luna",',
      '  prompt: "一只戴墨镜的橘猫，扁平插画风",',
      '  response_format: "b64_json"',
      '});',
      'console.log(image.data[0].b64_json.slice(0, 40) + "...");'
    ].join('\n');
  }
  return [
    '# Responses API（v2 强制 API Key）',
    'from openai import OpenAI',
    '',
    'client = OpenAI(',
    `    base_url="${base}",`,
    '    api_key="sk-duck-REPLACE_ME",',
    ')',
    '',
    'resp = client.responses.create(',
    '    model="gpt-6-luna",',
    '    instructions="你是一个严谨的中文技术助手。",',
    '    input="今天有什么科技新闻？",',
    '    tools=[{"type": "web_search"}],',
    ')',
    'print(resp.output_text)',
    'for item in resp.output:',
    '    print(item.type)',
    '',
    '# 流式事件：response.created → response.output_text.delta → response.completed',
    'with client.responses.stream(',
    '    model="gpt-6-luna",',
    '    input="用三句话解释什么是 MCP",',
    ') as stream:',
    '    for event in stream:',
    '        if event.type == "response.output_text.delta":',
    '            print(event.delta, end="", flush=True)'
  ].join('\n');
}

export function ExamplesPage() {
  const [tab, setTab] = useState<ExampleTab>('curl');
  const origin = gatewayOrigin();
  const code = useMemo(() => buildExample(tab, origin), [tab, origin]);

  return (
    <div>
      <PageHeader title="调用示例" description="复制即用；所有示例都已包含强制鉴权所需的 API Key" />

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3 text-sm">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="space-y-1">
          <p className="font-medium">所有 /v1/* 请求都必须携带 API Key</p>
          <p className="text-xs text-muted-foreground">
            把示例中的 <code className="rounded bg-muted px-1">sk-duck-REPLACE_ME</code> 替换为「API Key」页创建的 Key；
            或使用环境变量 <code className="rounded bg-muted px-1">DUCKAI_CPA_API_KEY</code>。付费模型需要
            <code className="mx-1 rounded bg-muted px-1">allowPaidModels=true</code> 且自身有 Plus/Pro 订阅。
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as ExampleTab)}>
        <TabsList className="mb-3 flex-wrap">
          {(Object.keys(TAB_LABELS) as ExampleTab[]).map((key) => (
            <TabsTrigger key={key} value={key}>
              {TAB_LABELS[key]}
            </TabsTrigger>
          ))}
        </TabsList>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-sm">{TAB_LABELS[tab]}</CardTitle>
                <Badge variant="outline" className="font-normal">
                  Authorization: Bearer
                </Badge>
              </div>
              <CopyButton value={code} label="复制代码" />
            </div>
            <CardDescription className="text-xs">
              Base URL：<span className="font-mono">{origin}/v1</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-[600px] overflow-auto rounded-xl border bg-zinc-950 p-4 text-[12.5px] leading-relaxed text-zinc-100">
              <code>{code}</code>
            </pre>
          </CardContent>
        </Card>
      </Tabs>
    </div>
  );
}
