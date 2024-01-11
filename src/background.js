'use strict'

/* global chrome */

import * as ch from './promisify.js'
import * as inject from './scripts/inject.js'

chrome.runtime.onInstalled.addListener(onInstalled)
chrome.runtime.onStartup.addListener(onStartup)
chrome.tabs.onActivated.addListener(onTabActivated)
chrome.tabs.onCreated.addListener(onTabCreated)
chrome.tabs.onRemoved.addListener(onTabRemoved)

const MAX_RECENT_TABS = 100

async function onInstalled () {
  await setActionTitle()
  await inject.injectScriptsIfNeeded()
}

async function onStartup () {
  await inject.injectScriptsIfNeeded()
}

async function setActionTitle () {
  const platformInfo = await ch.getPlatformInfo()
  let actionTitle

  if (platformInfo.os === 'mac') {
    actionTitle = `${chrome.i18n.getMessage('EXT_NAME_SHORT')} (${chrome.i18n.getMessage('ACCELERATOR_SEARCH_MAC')})`
  } else {
    actionTitle = `${chrome.i18n.getMessage('EXT_NAME_SHORT')} (${chrome.i18n.getMessage('ACCELERATOR_SEARCH')})`
  }

  await ch.actionSetTitle({ title: actionTitle })
}

async function onTabActivated (info) {
  await updateRecentTabs(info.tabId)
}

async function onTabCreated (tab) {
  await updateRecentTabs(tab.id)
}

async function onTabRemoved (tabId) {
  const response = await ch.storageGet({ recentTabs: [] })
  const recentTabs = response.recentTabs

  // Remove the closed tabId if it exists in the recentTabs array
  const index = recentTabs.indexOf(tabId)
  if (index > -1) {
    recentTabs.splice(index, 1)
  }

  await ch.storageSet({ recentTabs })
}

async function updateRecentTabs (tabId) {
  const response = await ch.storageGet({ recentTabs: [] })
  let recentTabs = response.recentTabs

  // Remove the tabId if it already exists
  const index = recentTabs.indexOf(tabId)
  if (index > -1) {
    recentTabs.splice(index, 1)
  }

  recentTabs.unshift(tabId)

  // Truncate array
  recentTabs = response.recentTabs.slice(0, MAX_RECENT_TABS)

  await ch.storageSet({ recentTabs })
}
