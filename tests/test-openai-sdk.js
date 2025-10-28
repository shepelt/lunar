import OpenAI from 'openai';

// Test 1: GPT-5 with OpenAI
console.log("\n=== Test 1: GPT-5 via OpenAI API ===");
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

try {
  const response1 = await openai.chat.completions.create({
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Say hello' }],
    max_tokens: 10
  });
  console.log("✓ Success with max_tokens:", response1.choices[0].message.content);
  console.log("Usage:", response1.usage);
} catch (error) {
  console.log("✗ Error with max_tokens:", error.message);
}

// Test 2: Ollama via OpenAI SDK
console.log("\n=== Test 2: Ollama via OpenAI SDK ===");
const ollama = new OpenAI({
  apiKey: 'dummy',
  baseURL: 'http://macserver.tailcdff5e.ts.net:11434/v1'
});

try {
  const response2 = await ollama.chat.completions.create({
    model: 'gpt-oss:120b',
    messages: [{ role: 'user', content: 'Say hello' }],
    max_tokens: 10
  });
  console.log("✓ Success with max_tokens:", response2.choices[0].message.content);
  console.log("Usage:", response2.usage);
} catch (error) {
  console.log("✗ Error with max_tokens:", error.message);
}
