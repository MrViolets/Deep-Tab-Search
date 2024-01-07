'use strict'

/* global chrome */

import * as ch from '../promisify.js'

export async function injectScriptsIfNeeded () {
  const allTabs = await ch.tabsQuery({ url: ['*://*/*'] })

  const promises = allTabs.map(tab => {
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
      return Promise.resolve()
    }

    return handleTab(tab)
  })

  await Promise.all(promises)
}

async function handleTab (tab) {
  // Check if the tab is discarded (unloaded)
  if (tab.discarded || tab.status === 'unloaded') {
    console.log(`Tab ${tab.id} is discarded, reloading`)
    await ch.tabsReload(tab.id)
    await waitForTabReload(tab.id)
  }

  // Try injecting the script
  try {
    await ch.sendMessageToTab(tab.id, { context: 'checkScriptStatus' })
  } catch {
    console.log('No content script found, attempting to inject script now')
    try {
      await ch.executeScript({
        target: { tabId: tab.id },
        files: ['./scripts/content.js']
      })
    } catch (injectError) {
      console.log('Error injecting content script:', injectError)
    }
  }
}

function waitForTabReload (tabId) {
  return new Promise((resolve) => {
    chrome.tabs.onUpdated.addListener(function listener (updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    })
  })
}
