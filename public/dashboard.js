// Dashboard state
let refreshInterval;

// Copy to clipboard fallback (works without HTTPS)
function copyToClipboardFallback(text, button) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    const successful = document.execCommand('copy');
    if (successful) {
      button.textContent = '✅ Copied!';
      setTimeout(() => button.textContent = '📋 Copy API Key', 2000);
    } else {
      button.textContent = '❌ Copy failed';
      setTimeout(() => button.textContent = '📋 Copy API Key', 2000);
    }
  } catch (err) {
    console.error('Fallback: Could not copy text', err);
    button.textContent = '❌ Copy failed';
    setTimeout(() => button.textContent = '📋 Copy API Key', 2000);
  }

  document.body.removeChild(textArea);
}

// Format currency
function formatCurrency(value) {
  return '$' + (value || 0).toFixed(4);
}

// Format number
function formatNumber(value) {
  return (value || 0).toLocaleString();
}

// Format date
function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

// Format time ago
function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Fetch consumers data
async function fetchConsumers() {
  try {
    const response = await fetch('/api/consumers');
    if (!response.ok) throw new Error('Failed to fetch consumers');
    return await response.json();
  } catch (error) {
    console.error('Error fetching consumers:', error);
    return [];
  }
}

// Fetch requests/audit log
async function fetchRequests(limit = 25) {
  try {
    const response = await fetch(`/api/audit?limit=${limit}`);
    if (!response.ok) throw new Error('Failed to fetch requests');
    return await response.json();
  } catch (error) {
    console.error('Error fetching requests:', error);
    return [];
  }
}

// Fetch config (for Ollama model name, etc.)
async function fetchConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Failed to fetch config');
    return await response.json();
  } catch (error) {
    console.error('Error fetching config:', error);
    return { ollama_model: 'gpt-oss:120b' };
  }
}

// Fetch provider statistics
async function fetchProviderStats() {
  try {
    const response = await fetch('/api/stats/providers');
    if (!response.ok) throw new Error('Failed to fetch provider stats');
    return await response.json();
  } catch (error) {
    console.error('Error fetching provider stats:', error);
    return [];
  }
}

// Render AI Proxy status
// Update config display (Ollama model name, etc.)
function updateConfigDisplay(config) {
  const ollamaModelElement = document.getElementById('ollama-model-name');
  if (ollamaModelElement && config.ollama_model) {
    ollamaModelElement.textContent = config.ollama_model;
  }
}

// Update statistics
function updateStats(consumers, requests) {
  const totalConsumers = consumers.length;
  const totalRequests = requests.length;
  const totalTokens = requests.reduce((sum, r) => sum + (r.total_tokens || 0), 0);
  const totalCost = requests.reduce((sum, r) => sum + (r.cost || 0), 0);

  document.getElementById('total-consumers').textContent = formatNumber(totalConsumers);
  document.getElementById('total-requests').textContent = formatNumber(totalRequests);
  document.getElementById('total-tokens').textContent = formatNumber(totalTokens);
  document.getElementById('total-cost').textContent = formatCurrency(totalCost);
}

// Render consumers table
function renderConsumersTable(consumers) {
  const tbody = document.querySelector('#consumers-table tbody');

  if (consumers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-gray-500 italic">No consumers found</td></tr>';
    return;
  }

  tbody.innerHTML = consumers.map(consumer => {
    const remaining = consumer.quota - consumer.used;
    const percentUsed = ((consumer.used / consumer.quota) * 100).toFixed(1);
    let badgeColor = 'bg-blue-100 text-blue-800';
    if (percentUsed > 80) badgeColor = 'bg-red-100 text-red-800';
    else if (percentUsed > 50) badgeColor = 'bg-yellow-100 text-yellow-800';

    return `
      <tr class="hover:bg-gray-50">
        <td class="px-4 py-3"><strong class="text-gray-900">${consumer.username || 'N/A'}</strong></td>
        <td class="px-4 py-3"><span class="font-mono text-xs text-gray-600">${consumer.id.substring(0, 16)}...</span></td>
        <td class="px-4 py-3 text-gray-700">${formatCurrency(consumer.quota)}</td>
        <td class="px-4 py-3"><span class="inline-block px-2 py-1 rounded text-xs font-medium ${badgeColor}">${formatCurrency(consumer.used)} (${percentUsed}%)</span></td>
        <td class="px-4 py-3 font-medium text-[#4949B4]">${formatCurrency(remaining)}</td>
        <td class="px-4 py-3 text-gray-700">${consumer.requests || 0}</td>
        <td class="px-4 py-3">
          <button
            class="delete-consumer-btn px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700 transition-colors"
            data-consumer-id="${consumer.id}"
            data-consumer-username="${consumer.username || 'N/A'}"
          >
            Delete
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // Attach delete event listeners
  document.querySelectorAll('.delete-consumer-btn').forEach(btn => {
    btn.addEventListener('click', handleDeleteConsumer);
  });
}

// Render requests table
function renderRequestsTable(requests) {
  const tbody = document.querySelector('#requests-table tbody');

  if (requests.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-gray-500 italic">No requests found</td></tr>';
    return;
  }

  tbody.innerHTML = requests.map(request => {
    const statusColor = request.status === 'success' ? 'text-[#4949B4] font-medium' : 'text-red-600 font-medium';
    const consumerId = request.consumer_id ? request.consumer_id.substring(0, 12) + '...' : 'N/A';

    // Blockchain badge
    let blockchainCell;
    if (request.blockchain_tx_hash) {
      const explorerUrl = `https://sepolia-explorer.hpp.io/tx/${request.blockchain_tx_hash}`;
      blockchainCell = `
        <div class="relative inline-block">
          <a href="${explorerUrl}"
             target="_blank"
             class="blockchain-badge inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 hover:bg-blue-200 transition-colors"
             data-tx-hash="${request.blockchain_tx_hash}"
             onmouseenter="showBlockchainTooltip(event)"
             onmouseleave="hideBlockchainTooltip(event)">
            <span class="mr-1">✓</span>
            <span>On-chain</span>
          </a>
          <div class="blockchain-tooltip hidden z-50 w-64 p-3 bg-gray-900 text-white text-xs rounded-lg shadow-lg">
            <div class="text-gray-400">Loading...</div>
          </div>
        </div>
      `;
    } else {
      blockchainCell = `
        <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
          <span class="mr-1">⏳</span>
          <span>Confirming...</span>
        </span>
      `;
    }

    return `
      <tr class="hover:bg-gray-50">
        <td class="px-4 py-3 text-sm text-gray-600" title="${formatDate(request.created_at)}">${timeAgo(request.created_at)}</td>
        <td class="px-4 py-3"><span class="font-mono text-xs text-gray-600">${consumerId}</span></td>
        <td class="px-4 py-3 text-gray-700">${request.provider || 'N/A'}</td>
        <td class="px-4 py-3 text-gray-700">${request.model || 'N/A'}</td>
        <td class="px-4 py-3 text-gray-700">${formatNumber(request.total_tokens)}</td>
        <td class="px-4 py-3 font-medium text-[#4949B4]">${formatCurrency(request.cost)}</td>
        <td class="px-4 py-3"><span class="${statusColor}">${request.status || 'unknown'}</span></td>
        <td class="px-4 py-3">${blockchainCell}</td>
      </tr>
    `;
  }).join('');
}

// Render combined provider info (endpoints + usage stats)
function renderProvidersCombined(stats, config) {
  const container = document.getElementById('providers-combined');

  // Get base URL for endpoints
  const baseUrl = config.lunar_endpoint_url || 'http://localhost:8000';

  // Provider configurations
  const providers = {
    'openai': {
      icon: '🤖',
      color: 'bg-green-50 border-green-200',
      textColor: 'text-green-700',
      name: 'OpenAI (Cloud)',
      description: 'GPT-4, GPT-4o, GPT-5',
      endpoint: `${baseUrl}/llm/v1/chat/completions`,
      pricing: '$1.25/1M input, $10/1M output'
    },
    'ollama': {
      icon: '🏠',
      color: 'bg-blue-50 border-blue-200',
      textColor: 'text-blue-700',
      name: 'Ollama (Local)',
      description: config.ollama_model || 'gpt-oss:120b',
      endpoint: `${baseUrl}/local-llm`,
      pricing: '$0 (on-premise)'
    }
  };

  // Create stats map
  const statsMap = {};
  stats.forEach(stat => {
    statsMap[stat.provider.toLowerCase()] = stat;
  });

  container.innerHTML = Object.entries(providers).map(([key, provider]) => {
    const stat = statsMap[key];
    const hasUsage = stat && stat.requests > 0;
    const isFree = key === 'ollama';

    return `
      <div class="border-2 ${provider.color} rounded-lg p-5 hover:shadow-lg transition-shadow">
        <!-- Header -->
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-3">
            <span class="text-3xl">${provider.icon}</span>
            <div>
              <h3 class="font-bold ${provider.textColor} text-lg">${provider.name}</h3>
              <span class="text-xs text-gray-500">${provider.description}</span>
            </div>
          </div>
          ${isFree ? '<span class="px-2 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">FREE</span>' : ''}
        </div>

        <!-- Endpoint -->
        <div class="bg-gray-50 rounded p-3 mb-4">
          <div class="flex items-center justify-between mb-1">
            <div class="text-xs text-gray-500">Endpoint:</div>
            <button
              onclick="copyToClipboard('${provider.endpoint}', this)"
              class="text-xs px-2 py-1 bg-white border border-gray-300 rounded hover:bg-gray-100 transition-colors"
              title="Copy to clipboard"
            >
              📋 Copy
            </button>
          </div>
          <div class="font-mono text-xs ${provider.textColor} font-medium break-all">${provider.endpoint}</div>
          <div class="text-xs text-gray-600 mt-2">${provider.pricing}</div>
        </div>

        <!-- Usage Stats -->
        ${hasUsage ? `
          <div class="border-t border-gray-200 pt-4 space-y-2">
            <div class="flex justify-between items-center">
              <span class="text-xs text-gray-600 uppercase tracking-wide">Requests:</span>
              <span class="font-bold ${provider.textColor}">${formatNumber(stat.requests)}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-xs text-gray-600 uppercase tracking-wide">Tokens:</span>
              <span class="font-semibold ${provider.textColor}">${formatNumber(stat.total_tokens)}</span>
            </div>
            <div class="flex justify-between items-center pt-2 border-t border-gray-100">
              <span class="text-xs text-gray-600 uppercase tracking-wide font-semibold">Total Cost:</span>
              <span class="font-bold ${isFree ? 'text-green-600' : 'text-brand-dark'} text-lg">${formatCurrency(stat.cost)}</span>
            </div>
          </div>
        ` : `
          <div class="border-t border-gray-200 pt-4">
            <div class="text-center text-gray-400 text-sm italic">No usage yet</div>
          </div>
        `}
      </div>
    `;
  }).join('');
}

// Load and refresh dashboard
async function loadDashboard() {
  const limit = document.getElementById('limit-select').value;

  const [consumers, requests, config, providerStats] = await Promise.all([
    fetchConsumers(),
    fetchRequests(limit),
    fetchConfig(),
    fetchProviderStats()
  ]);

  updateStats(consumers, requests);
  renderConsumersTable(consumers);
  renderRequestsTable(requests);
  renderProvidersCombined(providerStats, config);
}

// Create consumer
async function createConsumer(username, customId, quota) {
  try {
    const body = { username, quota: parseFloat(quota) };
    if (customId) body.custom_id = customId;

    const response = await fetch('/api/admin/consumers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to create consumer');
    }

    return data;
  } catch (error) {
    throw error;
  }
}

// Delete consumer
async function deleteConsumer(consumerId) {
  try {
    const response = await fetch(`/api/admin/consumers/${consumerId}`, {
      method: 'DELETE'
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to delete consumer');
    }

    return data;
  } catch (error) {
    throw error;
  }
}

// Handle delete consumer button click
async function handleDeleteConsumer(event) {
  const consumerId = event.target.dataset.consumerId;
  const consumerUsername = event.target.dataset.consumerUsername;

  if (!confirm(`Are you sure you want to delete consumer "${consumerUsername}"?\n\nThis will remove the consumer from Kong and delete all associated data.`)) {
    return;
  }

  try {
    event.target.disabled = true;
    event.target.textContent = 'Deleting...';

    await deleteConsumer(consumerId);

    // Refresh dashboard
    await loadDashboard();
  } catch (error) {
    alert(`Failed to delete consumer: ${error.message}`);
    event.target.disabled = false;
    event.target.textContent = 'Delete';
  }
}

// Show/hide create consumer form
function toggleCreateConsumerForm(show) {
  const form = document.getElementById('create-consumer-form');
  const messageDiv = document.getElementById('create-consumer-message');

  if (show) {
    form.classList.remove('hidden');
    // Clear form
    document.getElementById('consumer-username').value = '';
    document.getElementById('consumer-custom-id').value = '';
    document.getElementById('consumer-quota').value = '100';
    messageDiv.classList.add('hidden');
  } else {
    form.classList.add('hidden');
  }
}

// Show message in create consumer form
function showMessage(message, isError = false) {
  const messageDiv = document.getElementById('create-consumer-message');
  messageDiv.innerHTML = ''; // Clear previous content including buttons
  const textNode = document.createTextNode(message);
  messageDiv.appendChild(textNode);
  messageDiv.className = isError
    ? 'mt-3 p-3 rounded-lg bg-red-100 text-red-800 border border-red-300'
    : 'mt-3 p-3 rounded-lg bg-blue-100 text-blue-800 border border-blue-300';
  messageDiv.classList.remove('hidden');
}

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
  // Initial load
  loadDashboard();

  // Auto-refresh every 5 seconds
  refreshInterval = setInterval(loadDashboard, 5000);

  // Manual refresh button
  document.getElementById('refresh-btn').addEventListener('click', () => {
    loadDashboard();
  });

  // Limit select change
  document.getElementById('limit-select').addEventListener('change', () => {
    loadDashboard();
  });

  // Create consumer button
  document.getElementById('create-consumer-btn').addEventListener('click', () => {
    toggleCreateConsumerForm(true);
  });

  // Cancel button
  document.getElementById('cancel-consumer-btn').addEventListener('click', () => {
    toggleCreateConsumerForm(false);
  });

  // Submit consumer button
  document.getElementById('submit-consumer-btn').addEventListener('click', async () => {
    const username = document.getElementById('consumer-username').value.trim();
    const customId = document.getElementById('consumer-custom-id').value.trim();
    const quota = document.getElementById('consumer-quota').value;

    if (!username) {
      showMessage('Username is required', true);
      return;
    }

    if (!quota || quota <= 0) {
      showMessage('Quota must be greater than 0', true);
      return;
    }

    try {
      const submitBtn = document.getElementById('submit-consumer-btn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating...';

      const result = await createConsumer(username, customId, quota);

      showMessage(
        `Consumer created successfully!\n\nAPI Key: ${result.api_key}\n\n⚠️ Save this API key! It won't be shown again.`,
        false
      );

      // Add copy button to message
      const messageDiv = document.getElementById('create-consumer-message');
      const copyBtn = document.createElement('button');
      copyBtn.textContent = '📋 Copy API Key';
      copyBtn.className = 'mt-2 px-3 py-1 bg-white border border-[#4949B4] text-[#4949B4] rounded hover:bg-gray-50 transition-colors font-medium';
      copyBtn.onclick = () => {
        // Try modern clipboard API first, fallback to older method
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(result.api_key).then(() => {
            copyBtn.textContent = '✅ Copied!';
            setTimeout(() => copyBtn.textContent = '📋 Copy API Key', 2000);
          }).catch(() => {
            // Fallback if clipboard API fails
            copyToClipboardFallback(result.api_key, copyBtn);
          });
        } else {
          // Fallback for older browsers or non-HTTPS
          copyToClipboardFallback(result.api_key, copyBtn);
        }
      };
      messageDiv.appendChild(copyBtn);

      // Refresh dashboard (but don't close form)
      loadDashboard();
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      const submitBtn = document.getElementById('submit-consumer-btn');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create';
    }
  });
});

// LLM Test functionality
async function testLLM(apiKey, prompt, provider) {
  // Call backend proxy (same origin, no CORS issues)
  const response = await fetch('/api/llm-proxy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      api_key: apiKey,
      prompt: prompt,
      provider: provider,
      max_tokens: 150
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`LLM request failed (${response.status}): ${data.error?.message || data.error || JSON.stringify(data)}`);
  }

  return data;
}

// LLM Test button handler
document.addEventListener('DOMContentLoaded', () => {
  const testBtn = document.getElementById('test-llm-btn');
  const apiKeyInput = document.getElementById('test-api-key');
  const promptInput = document.getElementById('test-prompt');
  const endpointSelect = document.getElementById('test-endpoint-select');
  const responseContainer = document.getElementById('llm-response-container');
  const errorContainer = document.getElementById('llm-error-container');

  testBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const prompt = promptInput.value.trim();
    const endpoint = endpointSelect.value;

    // Hide previous results
    responseContainer.classList.add('hidden');
    errorContainer.classList.add('hidden');

    // Validate inputs
    if (!apiKey) {
      errorContainer.classList.remove('hidden');
      document.getElementById('llm-error-text').textContent = 'Please enter an API key';
      return;
    }

    if (!prompt) {
      errorContainer.classList.remove('hidden');
      document.getElementById('llm-error-text').textContent = 'Please enter a prompt';
      return;
    }

    try {
      testBtn.disabled = true;
      testBtn.textContent = 'Sending...';

      const result = await testLLM(apiKey, prompt, endpoint);

      // Display response
      const message = result.choices[0]?.message?.content || result.choices[0]?.message?.reasoning || 'No response';
      document.getElementById('llm-response-text').textContent = message;

      // Display token usage
      const usage = result.usage || {};
      document.getElementById('llm-prompt-tokens').textContent = formatNumber(usage.prompt_tokens || 0);
      document.getElementById('llm-completion-tokens').textContent = formatNumber(usage.completion_tokens || 0);

      // Calculate cost based on provider
      let cost = 0;
      if (endpoint === 'ollama') {
        cost = 0; // Local inference is free
      } else {
        // GPT-5 pricing
        cost = (usage.prompt_tokens * 0.00000125) + (usage.completion_tokens * 0.00001);
      }
      document.getElementById('llm-cost').textContent = formatCurrency(cost);

      responseContainer.classList.remove('hidden');

      // Refresh dashboard to show updated usage
      setTimeout(() => loadDashboard(), 1000);

    } catch (error) {
      errorContainer.classList.remove('hidden');
      document.getElementById('llm-error-text').textContent = error.message;
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Send Request';
    }
  });
});

// Blockchain tooltip cache (stores blockchain data, not HTML)
const blockchainCache = new Map();
let tooltipUpdateInterval = null;
let tooltipStartTime = null;

// Format time ago dynamically based on real elapsed time
function formatTimeAgo(secondsAgo) {
  if (secondsAgo < 60) return `${secondsAgo}s ago`;
  else if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)}m ago`;
  else if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)}h ago`;
  else return `${Math.floor(secondsAgo / 86400)}d ago`;
}

// Generate tooltip HTML with current time
function generateTooltipHTML(txHash, data, currentBlock, elapsedSeconds) {
  const confirmations = currentBlock - data.blockNumber + 1;
  const timeAgo = formatTimeAgo(elapsedSeconds);
  const gasUsed = Number(data.gasUsed).toLocaleString();

  return `
    <div class="space-y-1">
      <div class="text-white font-semibold mb-2">Transaction Details</div>
      <div class="text-gray-400">Block: <span class="text-white">#${data.blockNumber}</span></div>
      <div class="text-gray-400">Confirmations: <span class="text-[#8383D9]" data-dynamic-confirmations>${confirmations}</span></div>
      <div class="text-gray-400">Gas Used: <span class="text-white">${gasUsed}</span></div>
      <div class="text-gray-400">Time: <span class="text-white" data-dynamic-time>${timeAgo}</span></div>
      <div class="text-gray-400">Status: <span class="text-[#8383D9]">✓ Confirmed</span></div>
      <div class="mt-2 pt-2 border-t border-gray-700">
        <div class="text-gray-400 text-xs">Tx: ${txHash.substring(0, 10)}...${txHash.substring(txHash.length - 8)}</div>
      </div>
    </div>
  `;
}

// Show blockchain tooltip with on-chain data
async function showBlockchainTooltip(event) {
  const badge = event.currentTarget;
  const tooltip = badge.nextElementSibling;
  const txHash = badge.dataset.txHash;

  if (!txHash) return;

  // Position tooltip relative to viewport (fixed positioning)
  const rect = badge.getBoundingClientRect();
  tooltip.style.position = 'fixed';
  tooltip.style.top = `${rect.top}px`;
  tooltip.style.left = `${rect.left - 270}px`; // 270 = 264px width + 6px margin

  // Show tooltip
  tooltip.classList.remove('hidden');

  const web3 = new Web3('https://sepolia.hpp.io');

  // Track start time for elapsed calculation
  tooltipStartTime = Date.now();

  // Check cache first
  if (blockchainCache.has(txHash)) {
    const data = blockchainCache.get(txHash);
    const currentBlock = await web3.eth.getBlockNumber();
    const initialElapsed = Math.floor((Date.now() - data.timestamp) / 1000);
    tooltip.innerHTML = generateTooltipHTML(txHash, data, Number(currentBlock), initialElapsed);
  } else {
    // Query blockchain for first time
    try {
      // Get transaction receipt
      const receipt = await web3.eth.getTransactionReceipt(txHash);

      if (!receipt) {
        tooltip.innerHTML = '<div class="text-red-400">Transaction not found</div>';
        return;
      }

      // Get current block and block timestamp
      const currentBlock = await web3.eth.getBlockNumber();
      const block = await web3.eth.getBlock(receipt.blockNumber);
      const blockTimestamp = Number(block.timestamp) * 1000; // Convert to milliseconds

      // Cache blockchain data with timestamp
      const data = {
        blockNumber: Number(receipt.blockNumber),
        gasUsed: Number(receipt.gasUsed),
        timestamp: blockTimestamp
      };
      blockchainCache.set(txHash, data);

      // Calculate initial elapsed time
      const initialElapsed = Math.floor((Date.now() - blockTimestamp) / 1000);

      // Generate and display HTML
      tooltip.innerHTML = generateTooltipHTML(txHash, data, Number(currentBlock), initialElapsed);

    } catch (error) {
      console.error('Failed to fetch blockchain data:', error);
      tooltip.innerHTML = `<div class="text-red-400">Error loading data</div>`;
      return;
    }
  }

  // Update time every second while tooltip is visible
  clearInterval(tooltipUpdateInterval);
  let lastBlockCheck = Date.now();

  tooltipUpdateInterval = setInterval(async () => {
    if (tooltip.classList.contains('hidden')) {
      clearInterval(tooltipUpdateInterval);
      return;
    }

    const data = blockchainCache.get(txHash);
    if (data) {
      // Update time every second (based on real elapsed time)
      const elapsedSeconds = Math.floor((Date.now() - data.timestamp) / 1000);
      const timeElement = tooltip.querySelector('[data-dynamic-time]');
      if (timeElement) {
        timeElement.textContent = formatTimeAgo(elapsedSeconds);
      }

      // Update confirmations every 15 seconds (to check for new blocks)
      if (Date.now() - lastBlockCheck > 15000) {
        lastBlockCheck = Date.now();
        const currentBlock = await web3.eth.getBlockNumber();
        const confirmations = Number(currentBlock) - data.blockNumber + 1;
        const confirmationsElement = tooltip.querySelector('[data-dynamic-confirmations]');
        if (confirmationsElement) {
          confirmationsElement.textContent = confirmations;
        }
      }
    }
  }, 1000);
}

// Hide blockchain tooltip
function hideBlockchainTooltip(event) {
  const badge = event.currentTarget;
  const tooltip = badge.nextElementSibling;
  tooltip.classList.add('hidden');

  // Clear update interval
  if (tooltipUpdateInterval) {
    clearInterval(tooltipUpdateInterval);
    tooltipUpdateInterval = null;
  }
}

// Copy to clipboard function
function copyToClipboard(text, button) {
  navigator.clipboard.writeText(text).then(() => {
    // Store original text
    const originalText = button.textContent;

    // Show success feedback
    button.textContent = '✓ Copied!';
    button.classList.add('bg-green-100', 'text-green-700', 'border-green-300');
    button.classList.remove('bg-white', 'hover:bg-gray-100');

    // Reset after 2 seconds
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('bg-green-100', 'text-green-700', 'border-green-300');
      button.classList.add('bg-white', 'hover:bg-gray-100');
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy:', err);
    button.textContent = '✗ Failed';
    setTimeout(() => {
      button.textContent = '📋 Copy';
    }, 2000);
  });
}

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
