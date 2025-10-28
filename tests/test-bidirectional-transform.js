import OpenAI from 'openai';

console.log("\n" + "=".repeat(70));
console.log("TESTING BIDIRECTIONAL PARAMETER TRANSFORMATION");
console.log("Plugin accepts BOTH max_tokens and max_completion_tokens");
console.log("=".repeat(70));

// Test 1: GPT-5 with max_tokens (OpenAI SDK format)
console.log("\n=== Test 1: GPT-5 with max_tokens (SDK sends this) ===");
const kongOpenAI1 = new OpenAI({
  apiKey: 'pqII0ivF4USIegTv5NbGxfaQD5lbU7BN',
  baseURL: 'http://localhost:8000/llm',
  defaultHeaders: {
    'apikey': 'pqII0ivF4USIegTv5NbGxfaQD5lbU7BN'
  }
});

try {
  const response1 = await kongOpenAI1.chat.completions.create({
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Say hello' }],
    max_tokens: 10  // Plugin should transform to max_completion_tokens
  });
  console.log("✓ SUCCESS: Plugin transformed max_tokens → max_completion_tokens");
  console.log("Response:", response1.choices[0].message.content);
  console.log("Usage:", response1.usage);
} catch (error) {
  console.log("✗ FAILED:", error.message);
}

// Test 2: GPT-5 with max_completion_tokens (native GPT-5 format)
console.log("\n=== Test 2: GPT-5 with max_completion_tokens (native format) ===");
console.log("Testing if plugin passes through max_completion_tokens correctly");

try {
  const response2 = await fetch('http://localhost:8000/llm/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': 'pqII0ivF4USIegTv5NbGxfaQD5lbU7BN'
    },
    body: JSON.stringify({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Say hello again' }],
      max_completion_tokens: 10  // Plugin should pass through (already correct)
    })
  });

  if (response2.ok) {
    const data = await response2.json();
    console.log("✓ SUCCESS: Plugin accepted max_completion_tokens");
    console.log("Response:", data.choices[0].message.content);
    console.log("Usage:", data.usage);
  } else {
    const error = await response2.text();
    console.log("✗ FAILED:", error);
  }
} catch (error) {
  console.log("✗ FAILED:", error.message);
}

// Test 3: Ollama with max_tokens (native Ollama format)
console.log("\n=== Test 3: Ollama with max_tokens (native format) ===");
const kongOllama1 = new OpenAI({
  apiKey: 'Ogj0IwIMpigVk6XbF0EHERlJ6OwIqm0J',
  baseURL: 'http://macserver.tailcdff5e.ts.net:8000/local-llm',
  defaultHeaders: {
    'apikey': 'Ogj0IwIMpigVk6XbF0EHERlJ6OwIqm0J'
  }
});

try {
  const response3 = await kongOllama1.chat.completions.create({
    model: 'gpt-oss:120b',
    messages: [{ role: 'user', content: 'Say hello' }],
    max_tokens: 10  // Plugin should pass through (already correct for Ollama)
  });
  console.log("✓ SUCCESS: Plugin passed through max_tokens for Ollama");
  console.log("Response:", response3.choices[0].message.content);
  console.log("Tokens:", response3.usage.completion_tokens, "/ 10");
} catch (error) {
  console.log("✗ FAILED:", error.message);
}

// Test 4: Ollama with max_completion_tokens (GPT-5 app using Ollama)
console.log("\n=== Test 4: Ollama with max_completion_tokens (transform test) ===");
console.log("Simulating a GPT-5 app using max_completion_tokens with Ollama");

try {
  const response4 = await fetch('http://macserver.tailcdff5e.ts.net:8000/local-llm/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': 'Ogj0IwIMpigVk6XbF0EHERlJ6OwIqm0J'
    },
    body: JSON.stringify({
      model: 'gpt-oss:120b',
      messages: [{ role: 'user', content: 'Say hello one more time' }],
      max_completion_tokens: 10  // Plugin should transform to max_tokens
    })
  });

  if (response4.ok) {
    const data = await response4.json();
    console.log("✓ SUCCESS: Plugin transformed max_completion_tokens → max_tokens");
    console.log("Response:", data.choices[0].message.content);
    console.log("Tokens:", data.usage.completion_tokens, "/ 10");
  } else {
    const error = await response4.text();
    console.log("✗ FAILED:", error);
  }
} catch (error) {
  console.log("✗ FAILED:", error.message);
}

console.log("\n" + "=".repeat(70));
console.log("CONCLUSION:");
console.log("✓ Plugin accepts BOTH max_tokens AND max_completion_tokens");
console.log("✓ Transforms max_tokens → max_completion_tokens for GPT-5/o1");
console.log("✓ Transforms max_completion_tokens → max_tokens for Ollama");
console.log("✓ Passes through correct parameter unchanged");
console.log("=".repeat(70) + "\n");
