// Dashboard state
let refreshInterval;
let blockchainExplorerUrl = 'https://sepolia-explorer.hpp.io'; // Default, will be updated from backend
let blockchainRpcUrl = 'https://sepolia.hpp.io'; // Default, will be updated from backend

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
    const response = await fetch('/admin/api/consumers');
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
    const response = await fetch(`/admin/api/audit?limit=${limit}`);
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
    const response = await fetch('/admin/api/config');
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
    const response = await fetch('/admin/api/stats/providers');
    if (!response.ok) throw new Error('Failed to fetch provider stats');
    return await response.json();
  } catch (error) {
    console.error('Error fetching provider stats:', error);
    return [];
  }
}

// Fetch pricing configuration
async function fetchPricing() {
  try {
    const response = await fetch('/admin/api/pricing');
    if (!response.ok) throw new Error('Failed to fetch pricing');
    return await response.json();
  } catch (error) {
    console.error('Error fetching pricing:', error);
    return { pricing: [] };
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
    // Parse status as HTTP code if numeric, otherwise legacy string
    const httpCode = parseInt(request.status);
    const isNumericStatus = !isNaN(httpCode);

    // Color code based on HTTP status ranges
    let statusColor, statusText;
    if (isNumericStatus) {
      if (httpCode >= 200 && httpCode < 300) {
        // Success: green/blue
        statusColor = 'text-[#4949B4] font-medium';
        statusText = httpCode;
      } else if (httpCode >= 400 && httpCode < 500) {
        // Client errors (499 = cancelled, 404 = not found, etc.): orange/amber
        statusColor = 'text-amber-600 font-medium';
        statusText = httpCode;
      } else if (httpCode >= 500) {
        // Server errors: red
        statusColor = 'text-red-600 font-medium';
        statusText = httpCode;
      } else {
        // Other codes (3xx redirects, etc.): gray
        statusColor = 'text-gray-600 font-medium';
        statusText = httpCode;
      }
    } else {
      // Legacy: "success" or "error"
      statusColor = request.status === 'success' ? 'text-[#4949B4] font-medium' : 'text-red-600 font-medium';
      statusText = request.status || 'unknown';
    }

    const consumerId = request.consumer_id ? request.consumer_id.substring(0, 12) + '...' : 'N/A';

    // Blockchain badge
    let blockchainCell;
    if (request.blockchain_tx_hash) {
      const explorerUrl = `${blockchainExplorerUrl}/tx/${request.blockchain_tx_hash}`;
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
    } else if (request.response_hash && isNumericStatus && httpCode >= 200 && httpCode < 300) {
      // Successful request with response but not yet confirmed on blockchain
      blockchainCell = `
        <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
          <span class="mr-1">⏳</span>
          <span>Confirming...</span>
        </span>
      `;
    } else {
      // Failed/incomplete request (HTTP 4xx, 5xx, etc.) - won't be logged to blockchain
      blockchainCell = `
        <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600" title="Request failed or incomplete - not logged to blockchain">
          <span>N/A</span>
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
        <td class="px-4 py-3"><span class="${statusColor}">${statusText}</span></td>
        <td class="px-4 py-3">${blockchainCell}</td>
      </tr>
    `;
  }).join('');
}

// Update blockchain status display
function updateBlockchainStatus(config) {
  const blockchainSection = document.getElementById('blockchain-status');

  if (!config.blockchain_enabled || !config.blockchain_stats) {
    blockchainSection.classList.add('hidden');
    return;
  }

  const stats = config.blockchain_stats;

  // Update global explorer and RPC URLs if provided by backend
  if (stats.explorerUrl) {
    blockchainExplorerUrl = stats.explorerUrl;
  }
  if (stats.rpcUrl) {
    blockchainRpcUrl = stats.rpcUrl;
  }

  // Show section
  blockchainSection.classList.remove('hidden');

  // Update wallet info
  document.getElementById('wallet-address').textContent = stats.walletAddress || '-';
  document.getElementById('wallet-balance').textContent = stats.balance
    ? `${parseFloat(stats.balance).toFixed(4)} ETH`
    : '-';
  document.getElementById('estimated-txs-remaining').textContent =
    stats.estimatedTxsRemaining !== undefined
      ? formatNumber(stats.estimatedTxsRemaining)
      : '-';

  // Update contract info
  document.getElementById('contract-address').textContent = stats.contractAddress || '-';
  document.getElementById('blockchain-network').textContent = stats.network || '-';

  // Update stats
  const totalLogs = stats.database ? parseInt(stats.database.totalLogs) : parseInt(stats.totalLogs);
  document.getElementById('total-blockchain-logs').textContent = formatNumber(totalLogs || 0);

  // Update queue info
  const queue = stats.queue || {};
  document.getElementById('queue-length').textContent = queue.queueLength || 0;
  document.getElementById('queue-status').textContent = queue.processing ? 'processing' : 'idle';

  // Update Merkle batching metrics (if available)
  const merkleBatchingSection = document.getElementById('merkle-batching-section');
  if (stats.totalBatches !== undefined && stats.queue) {
    merkleBatchingSection.classList.remove('hidden');

    // Total batches
    document.getElementById('total-batches').textContent = formatNumber(parseInt(stats.totalBatches) || 0);

    // Batch configuration
    document.getElementById('batch-size').textContent = queue.configuredBatchSize || queue.batchSize || '-';
    const batchIntervalSec = queue.batchInterval ? Math.round(queue.batchInterval / 1000) : '-';
    document.getElementById('batch-interval').textContent = batchIntervalSec;

    // Daily budget (today's usage)
    if (stats.today) {
      document.getElementById('today-tx-count').textContent = formatNumber(stats.today.tx_count || 0);
      document.getElementById('today-tx-limit').textContent = formatNumber(queue.maxTxsPerDay || 2000);
      document.getElementById('today-request-count').textContent = formatNumber(stats.today.request_count || 0);
    } else {
      document.getElementById('today-tx-count').textContent = '-';
      document.getElementById('today-tx-limit').textContent = '-';
      document.getElementById('today-request-count').textContent = '-';
    }

    // Adaptive batching status
    const adaptiveEnabled = queue.adaptiveBatching !== false;
    const adaptiveStatusEl = document.getElementById('adaptive-status');
    if (adaptiveEnabled) {
      adaptiveStatusEl.textContent = '✅ Enabled';
      adaptiveStatusEl.className = 'text-lg font-semibold text-green-600';
    } else {
      adaptiveStatusEl.textContent = '⚪ Disabled';
      adaptiveStatusEl.className = 'text-lg font-semibold text-gray-500';
    }

    // Current batch size (may be different from configured if adaptive)
    const currentBatchSize = queue.currentBatchSize || queue.configuredBatchSize || queue.batchSize || '-';
    document.getElementById('current-batch-size').textContent = currentBatchSize;
  } else {
    merkleBatchingSection.classList.add('hidden');
  }
}

// Render combined provider info (usage stats only)
function renderProvidersCombined(stats, config) {
  const container = document.getElementById('providers-combined');

  // Update endpoint displays
  const baseUrl = config.noosphere_router_endpoint_url || 'http://localhost:8000';
  const unifiedEndpoint = `${baseUrl}/llm/v1/chat/completions`;
  const anthropicEndpoint = `${baseUrl}/v1/messages`;
  document.getElementById('unified-endpoint').textContent = unifiedEndpoint;
  document.getElementById('anthropic-endpoint').textContent = anthropicEndpoint;

  // Provider configurations
  const providers = {
    'openai': {
      icon: '🤖',
      color: 'bg-green-50 border-green-200',
      textColor: 'text-green-700',
      name: 'OpenAI',
      description: 'GPT-4, GPT-4o, GPT-5'
    },
    'anthropic': {
      icon: '🧠',
      color: 'bg-purple-50 border-purple-200',
      textColor: 'text-purple-700',
      name: 'Anthropic',
      description: 'Claude models (Sonnet, Opus, Haiku)'
    },
    'ollama': {
      icon: '🏠',
      color: 'bg-blue-50 border-blue-200',
      textColor: 'text-blue-700',
      name: 'Ollama',
      description: config.ollama_model || 'gpt-oss:120b'
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
        <div class="flex items-center gap-3 mb-4">
          <span class="text-4xl">${provider.icon}</span>
          <div class="flex-1">
            <h3 class="font-bold ${provider.textColor} text-xl">${provider.name}</h3>
            <div class="text-xs text-gray-500 mt-1">${provider.description}</div>
          </div>
        </div>

        <!-- Usage Stats -->
        ${hasUsage ? `
          <div class="space-y-3">
            <div class="bg-white rounded p-3">
              <div class="text-xs text-gray-500 uppercase">Requests</div>
              <div class="text-2xl font-bold ${provider.textColor}">${formatNumber(stat.requests)}</div>
            </div>
            <div class="bg-white rounded p-3">
              <div class="text-xs text-gray-500 uppercase">Tokens</div>
              <div class="text-lg font-semibold ${provider.textColor}">${formatNumber(stat.total_tokens)}</div>
            </div>
            <div class="bg-white rounded p-3 border-2 ${isFree ? 'border-green-200' : 'border-purple-200'}">
              <div class="text-xs text-gray-500 uppercase">Total Cost</div>
              <div class="text-2xl font-bold ${isFree ? 'text-green-600' : 'text-brand-dark'}">${formatCurrency(stat.cost)}</div>
            </div>
          </div>
        ` : `
          <div class="bg-white rounded p-6">
            <div class="text-center text-gray-400 text-sm italic">No usage yet</div>
          </div>
        `}
      </div>
    `;
  }).join('');
}

// Render pricing table
function renderPricingTable(pricingInfo) {
  const tbody = document.getElementById('pricing-table-body');

  if (!pricingInfo || !pricingInfo.pricing || pricingInfo.pricing.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-8 text-center text-gray-500">No pricing data available</td></tr>';
    return;
  }

  // Sort pricing: Anthropic, OpenAI, Ollama
  const sortOrder = { 'anthropic': 1, 'openai': 2, 'ollama': 3 };
  const sortedPricing = [...pricingInfo.pricing].sort((a, b) => {
    return (sortOrder[a.provider] || 99) - (sortOrder[b.provider] || 99);
  });

  tbody.innerHTML = sortedPricing.map(p => {
    const inputPrice = (p.inputRate * 1_000_000).toFixed(2);
    const outputPrice = (p.outputRate * 1_000_000).toFixed(2);
    const cacheWrite = p.cacheWriteRate ? (p.cacheWriteRate * 1_000_000).toFixed(2) : '-';
    const cacheRead = p.cacheReadRate ? (p.cacheReadRate * 1_000_000).toFixed(2) : '-';
    const updated = new Date(p.updatedAt).toLocaleString();

    const providerIcon = {
      'anthropic': '🧠',
      'openai': '🤖',
      'ollama': '🏠'
    }[p.provider] || '❓';

    const providerName = p.provider.charAt(0).toUpperCase() + p.provider.slice(1);
    const modelDisplay = p.model && p.model !== ''
      ? `<span class="text-gray-600"> • ${p.model}</span>`
      : '<span class="text-gray-400 text-sm"> (default)</span>';

    return `
      <tr class="border-t hover:bg-gray-50">
        <td class="px-4 py-3 font-medium">${providerIcon} ${providerName}${modelDisplay}</td>
        <td class="px-4 py-3 text-right font-mono text-sm">$${inputPrice}</td>
        <td class="px-4 py-3 text-right font-mono text-sm">$${outputPrice}</td>
        <td class="px-4 py-3 text-right font-mono text-sm text-gray-600">${cacheWrite}</td>
        <td class="px-4 py-3 text-right font-mono text-sm text-gray-600">${cacheRead}</td>
        <td class="px-4 py-3 text-right text-xs text-gray-500">${updated}</td>
      </tr>
    `;
  }).join('');

  // No need to set max-height here since table starts collapsed
}

// Update pricing via API (bulk update with JSON array)
async function updatePricingBulk(pricingArray) {
  try {
    // Convert $/1M to rate (divide by 1,000,000)
    const pricing = pricingArray.map(p => ({
      provider: p.provider,
      model: p.model || '',
      inputRate: parseFloat(p.inputRate) / 1_000_000,
      outputRate: parseFloat(p.outputRate) / 1_000_000,
      cacheWriteRate: p.cacheWriteRate ? parseFloat(p.cacheWriteRate) / 1_000_000 : null,
      cacheReadRate: p.cacheReadRate ? parseFloat(p.cacheReadRate) / 1_000_000 : null
    }));

    const response = await fetch('/admin/api/pricing/bulk', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pricing })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to update pricing');
    }

    return data;
  } catch (error) {
    throw error;
  }
}

// Update pricing via API (legacy single update - kept for compatibility)
async function updatePricing(provider, model, inputRatePer1M, outputRatePer1M, cacheWriteRatePer1M, cacheReadRatePer1M) {
  try {
    const body = {
      provider,
      model: model || '', // Empty string for default pricing
      // Convert $/1M to rate (divide by 1,000,000)
      inputRate: parseFloat(inputRatePer1M) / 1_000_000,
      outputRate: parseFloat(outputRatePer1M) / 1_000_000
    };

    // Only include cache rates if they're provided
    if (cacheWriteRatePer1M) {
      body.cacheWriteRate = parseFloat(cacheWriteRatePer1M) / 1_000_000;
    }
    if (cacheReadRatePer1M) {
      body.cacheReadRate = parseFloat(cacheReadRatePer1M) / 1_000_000;
    }

    const response = await fetch('/admin/api/pricing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to update pricing');
    }

    return data;
  } catch (error) {
    throw error;
  }
}

// Show pricing message
function showPricingMessage(message, isError = false) {
  const messageDiv = document.getElementById('pricing-message');
  messageDiv.textContent = message;
  messageDiv.className = isError
    ? 'mt-3 p-3 rounded-lg bg-red-100 text-red-800 border border-red-300'
    : 'mt-3 p-3 rounded-lg bg-green-100 text-green-800 border border-green-300';
  messageDiv.classList.remove('hidden');

  // Auto-hide after 5 seconds
  setTimeout(() => {
    messageDiv.classList.add('hidden');
  }, 5000);
}

// Load and refresh dashboard
async function loadDashboard() {
  const limit = document.getElementById('limit-select').value;

  const [consumers, requests, config, providerStats, pricing] = await Promise.all([
    fetchConsumers(),
    fetchRequests(limit),
    fetchConfig(),
    fetchProviderStats(),
    fetchPricing()
  ]);

  updateStats(consumers, requests);
  renderConsumersTable(consumers);
  renderRequestsTable(requests);
  renderProvidersCombined(providerStats, config);
  renderPricingTable(pricing);
  updateBlockchainStatus(config);
}

// Create consumer
async function createConsumer(username, customId, quota) {
  try {
    const body = { username, quota: parseFloat(quota) };
    if (customId) body.custom_id = customId;

    const response = await fetch('/admin/api/admin/consumers', {
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
    const response = await fetch(`/admin/api/admin/consumers/${consumerId}`, {
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

  // Pricing provider change - show/hide cache fields
  const pricingJsonEditor = document.getElementById('pricing-json-editor');

  // Format JSON button
  document.getElementById('format-json-btn').addEventListener('click', () => {
    try {
      const json = JSON.parse(pricingJsonEditor.value);
      pricingJsonEditor.value = JSON.stringify(json, null, 2);
      showPricingMessage('✅ JSON formatted', false);
      setTimeout(() => {
        document.getElementById('pricing-message').classList.add('hidden');
      }, 2000);
    } catch (error) {
      showPricingMessage('❌ Invalid JSON: ' + error.message, true);
    }
  });

  // Toggle pricing table visibility (start collapsed to save space)
  let pricingTableExpanded = false;
  const pricingTableContainer = document.getElementById('pricing-table-container');
  const pricingChevron = document.getElementById('pricing-chevron');

  // Set initial collapsed state
  pricingTableContainer.style.maxHeight = '0px';
  pricingChevron.style.transform = 'rotate(-90deg)';

  document.getElementById('toggle-pricing-table').addEventListener('click', () => {
    pricingTableExpanded = !pricingTableExpanded;

    if (pricingTableExpanded) {
      // Recalculate scrollHeight in case content changed
      pricingTableContainer.style.maxHeight = 'none';
      const height = pricingTableContainer.scrollHeight;
      pricingTableContainer.style.maxHeight = '0px';
      // Trigger reflow
      pricingTableContainer.offsetHeight;
      pricingTableContainer.style.maxHeight = height + 'px';
      pricingChevron.style.transform = 'rotate(0deg)';
    } else {
      pricingTableContainer.style.maxHeight = '0px';
      pricingChevron.style.transform = 'rotate(-90deg)';
    }
  });

  // Open pricing modal
  document.getElementById('open-pricing-modal-btn').addEventListener('click', async () => {
    document.getElementById('pricing-modal').classList.remove('hidden');

    // Load current pricing as JSON
    const pricingData = await fetchPricing();
    if (pricingData && pricingData.pricing) {
      // Convert to user-friendly format (rates as $/1M)
      const pricingForEdit = pricingData.pricing.map(p => ({
        provider: p.provider,
        model: p.model || '',
        inputRate: parseFloat((p.inputRate * 1_000_000).toFixed(2)),
        outputRate: parseFloat((p.outputRate * 1_000_000).toFixed(2)),
        cacheWriteRate: p.cacheWriteRate ? parseFloat((p.cacheWriteRate * 1_000_000).toFixed(2)) : null,
        cacheReadRate: p.cacheReadRate ? parseFloat((p.cacheReadRate * 1_000_000).toFixed(2)) : null
      }));

      pricingJsonEditor.value = JSON.stringify(pricingForEdit, null, 2);
    }
  });

  // Close pricing modal
  const closePricingModal = () => {
    document.getElementById('pricing-modal').classList.add('hidden');
  };

  document.getElementById('close-pricing-modal-btn').addEventListener('click', closePricingModal);
  document.getElementById('cancel-pricing-btn').addEventListener('click', closePricingModal);

  // Close modal when clicking outside
  document.getElementById('pricing-modal').addEventListener('click', (e) => {
    if (e.target.id === 'pricing-modal') {
      closePricingModal();
    }
  });

  // Update pricing button
  document.getElementById('update-pricing-btn').addEventListener('click', async () => {
    try {
      // Parse JSON
      const pricingArray = JSON.parse(pricingJsonEditor.value);

      // Validate
      if (!Array.isArray(pricingArray)) {
        throw new Error('Pricing must be an array');
      }

      if (pricingArray.length === 0) {
        throw new Error('Pricing array cannot be empty');
      }

      // Validate each entry
      for (const p of pricingArray) {
        if (!p.provider) throw new Error('Each entry must have a provider');
        if (typeof p.inputRate !== 'number' || p.inputRate < 0) throw new Error('inputRate must be a non-negative number');
        if (typeof p.outputRate !== 'number' || p.outputRate < 0) throw new Error('outputRate must be a non-negative number');
      }

      const btn = document.getElementById('update-pricing-btn');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      await updatePricingBulk(pricingArray);

      showPricingMessage(`✅ Pricing updated successfully (${pricingArray.length} models)! Cache will reload on next request.`);

      // Reload dashboard to show new pricing (keep modal open for further edits)
      setTimeout(() => {
        loadDashboard();
      }, 1500);
    } catch (error) {
      showPricingMessage(`❌ ${error.message}`, true);
    } finally {
      const btn = document.getElementById('update-pricing-btn');
      btn.disabled = false;
      btn.textContent = '💾 Save All Pricing';
    }
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
async function testLLM(apiKey, prompt, provider, model) {
  // Call backend proxy (same origin, no CORS issues)
  const response = await fetch('/admin/api/llm-proxy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      api_key: apiKey,
      prompt: prompt,
      provider: provider,
      model: model
      // No max_tokens - let the model respond naturally
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
  const modelSelect = document.getElementById('test-model-select');
  const modelDisplay = document.getElementById('test-model-display');
  const responseContainer = document.getElementById('llm-response-container');
  const errorContainer = document.getElementById('llm-error-container');

  // Store pricing data for cost calculation
  let pricingData = [];

  // Load models from pricing API
  async function loadModels() {
    try {
      const data = await fetchPricing();
      if (data && data.pricing) {
        pricingData = data.pricing;
        populateModelDropdown(data.pricing);
      }
    } catch (error) {
      console.error('Failed to load models:', error);
      modelSelect.innerHTML = '<option value="">Error loading models</option>';
    }
  }

  // Populate model dropdown with all available models
  function populateModelDropdown(pricing) {
    // Group models by provider
    const grouped = {};
    pricing.forEach(p => {
      if (!grouped[p.provider]) {
        grouped[p.provider] = [];
      }
      grouped[p.provider].push(p);
    });

    // Clear existing options
    modelSelect.innerHTML = '';

    // Add options grouped by provider
    Object.keys(grouped).sort().forEach(provider => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = provider.charAt(0).toUpperCase() + provider.slice(1);

      grouped[provider]
        .sort((a, b) => (a.model || '').localeCompare(b.model || ''))
        .forEach(p => {
          const option = document.createElement('option');
          option.value = `${p.provider}/${p.model || 'default'}`;
          const modelName = p.model || '(default)';
          option.textContent = modelName;
          optgroup.appendChild(option);
        });

      modelSelect.appendChild(optgroup);
    });

    // Select first option
    if (modelSelect.options.length > 0) {
      modelSelect.selectedIndex = 0;
      updateModelDisplay();
    }
  }

  // Update model display
  function updateModelDisplay() {
    const selectedValue = modelSelect.value;
    if (selectedValue) {
      modelDisplay.textContent = selectedValue;
    }
  }

  // Load models on page load
  loadModels();

  // Update display when model changes
  modelSelect.addEventListener('change', updateModelDisplay);

  // Load saved API key from localStorage
  const savedApiKey = localStorage.getItem('noosphere_router_test_api_key');
  if (savedApiKey) {
    apiKeyInput.value = savedApiKey;
  }

  // Save API key to localStorage on change
  apiKeyInput.addEventListener('input', () => {
    const apiKey = apiKeyInput.value.trim();
    if (apiKey) {
      localStorage.setItem('noosphere_router_test_api_key', apiKey);
    } else {
      localStorage.removeItem('noosphere_router_test_api_key');
    }
  });

  testBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const prompt = promptInput.value.trim();
    const selectedModel = modelSelect.value;

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

    if (!selectedModel) {
      errorContainer.classList.remove('hidden');
      document.getElementById('llm-error-text').textContent = 'Please select a model';
      return;
    }

    // Parse provider/model from dropdown value
    const [provider, model] = selectedModel.split('/');

    try {
      testBtn.disabled = true;
      testBtn.textContent = 'Sending...';

      const result = await testLLM(apiKey, prompt, provider, model === 'default' ? '' : model);

      // Display response
      const message = result.choices[0]?.message?.content || result.choices[0]?.message?.reasoning || 'No response';
      document.getElementById('llm-response-text').textContent = message;

      // Display token usage
      const usage = result.usage || {};
      const promptTokens = usage.prompt_tokens || usage.input_tokens || 0;
      const completionTokens = usage.completion_tokens || usage.output_tokens || 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
      const cacheReadTokens = usage.cache_read_input_tokens || 0;

      document.getElementById('llm-prompt-tokens').textContent = formatNumber(promptTokens);
      document.getElementById('llm-completion-tokens').textContent = formatNumber(completionTokens);

      // Calculate cost using actual pricing data
      let cost = 0;
      const pricing = pricingData.find(p =>
        p.provider === provider &&
        (p.model === model || (p.model === '' && model === 'default'))
      );

      if (pricing) {
        cost = (promptTokens * pricing.inputRate) +
               (completionTokens * pricing.outputRate) +
               (cacheCreationTokens * (pricing.cacheWriteRate || 0)) +
               (cacheReadTokens * (pricing.cacheReadRate || 0));
      } else {
        console.warn('No pricing found for', provider, model);
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

  const web3 = new Web3(blockchainRpcUrl);

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
