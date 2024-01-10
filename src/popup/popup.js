'use strict'

/* global chrome */

import * as ch from '../promisify.js'
import * as inject from '../scripts/inject.js'
import * as navigation from './navigation.js'

let currentSearchId = 0
let currentHistoryIndex = -1
let isSearching = false
let isModifierKeyPressed = false
let isIndexingComplete = false
let cachedResultTemplate = null
let cachedSearchTemplate = null
let cachedHistoryTemplate = null

document.addEventListener('DOMContentLoaded', init)

async function init () {
  await insertStrings()
  registerListeners()
  navigation.init()

  const searchInputEl = document.getElementById('search')
  searchInputEl.focus()

  const updatePlaceholderAfterDelay = () => {
    setTimeout(() => {
      if (!isIndexingComplete) {
        searchInputEl.placeholder = chrome.i18n.getMessage('PLACEHOLDER_INDEXING')
      }
    }, 100)
  }

  updatePlaceholderAfterDelay()
  await preloadTemplates()
  await renderAllTabs()

  await inject.injectScriptsIfNeeded()

  isIndexingComplete = true
  searchInputEl.placeholder = chrome.i18n.getMessage('PLACEHOLDER_SEARCH')
}

async function preloadTemplates () {
  cachedResultTemplate = await getCachedTemplate('result-fragment.html', cachedResultTemplate)
  cachedSearchTemplate = await getCachedTemplate('search-fragment.html', cachedSearchTemplate)
  cachedHistoryTemplate = await getCachedTemplate('history-fragment.html', cachedHistoryTemplate)
}

async function getCachedTemplate (templateUrl, cacheVariable) {
  if (!cacheVariable) {
    const response = await fetch(templateUrl)
    cacheVariable = await response.text()
  }
  return cacheVariable
}

async function renderAllTabs () {
  const resultsContainerEl = document.getElementById('results')
  let allTabs = await ch.tabsQuery({ url: ['*://*/*'] })
  const currentWindow = await ch.windowsGetCurrent()
  const fragment = document.createDocumentFragment()

  const response = await ch.storageGet({ recentTabs: [] })
  const recentTabIds = response.recentTabs

  // Sort tabs with most recently accessed first
  if (recentTabIds.length > 0) {
    const recentTabs = allTabs.filter((tab) => recentTabIds.includes(tab.id))
    recentTabs.sort((a, b) => recentTabIds.indexOf(a.id) - recentTabIds.indexOf(b.id))

    // Remove recent tabs from allTabs
    allTabs = allTabs.filter((tab) => !recentTabIds.includes(tab.id))

    allTabs = recentTabs.concat(allTabs)
  }

  for (const tab of allTabs) {
    if (isSearching) {
      return
    }

    const searchResult = {
      id: tab.id,
      url: tab.url,
      hostname: new URL(tab.url).hostname,
      title: tab.title,
      searchQuery: '',
      results: [],
      relevanceScore: 0,
      isCurrentWindow: tab.windowId === currentWindow.id,
      hasSnippets: false
    }

    await renderSearchResult(searchResult, fragment)
  }

  resultsContainerEl.innerHTML = ''
  resultsContainerEl.appendChild(fragment)

  if (allTabs.length > 0) {
    navigation.selectFirstOption()
  }
}

async function insertStrings () {
  const accelerators = document.querySelectorAll('[data-accelerator]')

  const platformInfo = await ch.getPlatformInfo().catch((error) => {
    console.error(error)
  })

  if (accelerators) {
    for (const a of accelerators) {
      if (platformInfo.os === 'mac') {
        a.innerText = chrome.i18n.getMessage(`ACCELERATOR_${a.dataset.accelerator}_MAC`)
      } else {
        a.innerText = chrome.i18n.getMessage(`ACCELERATOR_${a.dataset.accelerator}`)
      }
    }
  }
}

function registerListeners () {
  document.getElementById('search').addEventListener('input', onSearchInput, false)
  document.getElementById('search').addEventListener('keydown', onSearchKeydown, false)
  document.getElementById('results').addEventListener('click', onResultsClicked, false)

  document.body.addEventListener('keydown', onDocumentKeydown)
  document.body.addEventListener('keyup', onDocumentKeyup)
}

async function onSearchInput () {
  const searchId = ++currentSearchId
  const query = this.value
  const resultsContainerEl = document.getElementById('results')
  const acceleratorEl = document.querySelector('.accelerator')

  isSearching = query.length > 0

  if (query.length === 0) {
    acceleratorEl.classList.remove('hidden')
    await renderAllTabs()
    return
  }

  const allTabs = await ch.tabsQuery({ url: ['*://*/*'] })
  const currentWindow = await ch.windowsGetCurrent()

  const nonRespondedTabs = []
  const searchPromises = allTabs.map((tab) =>
    ch
      .sendMessageToTab(tab.id, { context: 'search', searchQuery: query, searchId })
      .then((response) => {
        if (response.searchId !== searchId) {
          // This response is from an outdated input event, ignore it
          return null
        }

        return response.matchFoundAnywhere
          ? {
              id: tab.id,
              url: tab.url,
              hostname: new URL(tab.url).hostname,
              title: tab.title,
              searchQuery: query,
              results: response.results,
              isCurrentWindow: tab.windowId === currentWindow.id,
              hasSnippets: response.results.length > 0,
              relevance: response.relevanceScore
            }
          : null
      })
      .catch((error) => {
        console.error('Cannot send message to', tab.url, error)
        // Add tab to non-responded tabs
        nonRespondedTabs.push(tab)
        return null
      })
  )

  const results = (await Promise.allSettled(searchPromises)).filter((result) => result.status === 'fulfilled' && result.value !== null).map((result) => result.value)

  if (nonRespondedTabs.length > 0) {
    const queryLower = query.toLowerCase()

    // Perform a simple search on non-responded tabs
    for (const tab of nonRespondedTabs) {
      const url = new URL(tab.url)

      const urlMatch = url.href.toLowerCase().includes(queryLower)
      const hostMatch = url.hostname.toLowerCase().includes(queryLower)
      const titleMatch = tab.title.toLowerCase().includes(queryLower)

      if (urlMatch || hostMatch || titleMatch) {
        results.push({
          id: tab.id,
          url: tab.url,
          hostname: new URL(tab.url).hostname,
          title: tab.title,
          searchQuery: query,
          isCurrentWindow: tab.windowId === currentWindow.id,
          hasSnippets: false,
          relevance: 0
        })
      }
    }
  }

  // Sort results by relevance
  results.sort((a, b) => b.relevance - a.relevance)

  console.log(results, query)

  const fragment = document.createDocumentFragment()

  for (const result of results) {
    if (result) {
      await renderSearchResult(result, fragment)
    }
  }

  await renderWebSearchItem(query, fragment)

  const response = await ch.storageGet({ history: [] })
  const renderedItems = new Set()

  for (const historyItem of response.history) {
    const itemLower = historyItem.toLowerCase()
    const queryLower = query.toLowerCase()

    if (itemLower.includes(queryLower) && !renderedItems.has(itemLower)) {
      await renderHistoryItem(historyItem, query, fragment)
      renderedItems.add(itemLower)
    }
  }

  acceleratorEl.classList.add('hidden')
  resultsContainerEl.innerHTML = ''
  resultsContainerEl.appendChild(fragment)

  const resultsElements = document.querySelectorAll('.results')

  if (resultsElements.length > 0) {
    navigation.selectFirstOption()
  }
}

async function renderWebSearchItem (text, parent) {
  cachedSearchTemplate = await getCachedTemplate('search-fragment.html', cachedSearchTemplate)
  const template = document.createElement('template')
  template.innerHTML = cachedSearchTemplate
  const fragment = template.content

  const searchEl = fragment.querySelector('.list-item')
  searchEl.dataset.query = text

  const titleEl = fragment.querySelector('.title')
  titleEl.innerText = text

  parent.appendChild(fragment)
}

async function renderHistoryItem (text, query, parent) {
  cachedHistoryTemplate = await getCachedTemplate('history-fragment.html', cachedHistoryTemplate)
  const template = document.createElement('template')
  template.innerHTML = cachedHistoryTemplate
  const fragment = template.content

  const historyEl = fragment.querySelector('.list-item')
  historyEl.dataset.query = text

  const titleEl = fragment.querySelector('.title')
  titleEl.innerHTML = highlightText(text, query)

  parent.appendChild(fragment)
}

async function renderSearchResult (searchResult, parent) {
  // Fetch and parse the HTML fragment
  cachedResultTemplate = await getCachedTemplate('result-fragment.html', cachedResultTemplate)
  const template = document.createElement('template')
  template.innerHTML = cachedResultTemplate
  const fragment = template.content

  // Set the data-id attribute to the tab id
  const resultEl = fragment.querySelector('.list-item')
  resultEl.dataset.id = searchResult.id // Update the data-id with searchResult.id
  resultEl.dataset.hasSnippets = searchResult.hasSnippets

  // Update the fragment with search result data
  const faviconEl = fragment.querySelector('.favicon')
  faviconEl.setAttribute('src', `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(searchResult.url)}&size=32`)

  const titleEl = fragment.querySelector('.title')
  titleEl.innerHTML = highlightText(searchResult.title, searchResult.searchQuery)

  const urlEl = fragment.querySelector('.url')
  urlEl.innerText = new URL(searchResult.url).hostname

  const rightLabelEl = fragment.querySelector('.right-detail-label')
  rightLabelEl.innerText = chrome.i18n.getMessage('SEARCH_RESULT_GO_TO_TAB')

  const rightDetailIcon = fragment.querySelector('.right-detail-icon')
  const iconClass = searchResult.isCurrentWindow ? 'current' : 'external'
  rightDetailIcon.classList.add(iconClass)

  const resultsContainer = fragment.querySelector('.snippet-container')

  if (searchResult.results && searchResult.results.length > 0) {
    for (let i = 0; i < searchResult.results.length; i++) {
      const result = searchResult.results[i]
      const highlightedResult = highlightText(result.snippet, searchResult.searchQuery)
      const individualResult = document.createElement('div')
      individualResult.innerHTML = highlightedResult
      individualResult.classList.add('result-line')
      resultsContainer.appendChild(individualResult)
    }
  } else if (resultsContainer) {
    resultsContainer.remove()
  }

  // Append the fragment to the parent
  parent.appendChild(fragment)
}

function highlightText (text, query) {
  const escapedQuery = escapeRegExp(query)
  return text.replace(new RegExp(escapedQuery, 'gi'), (match) => `<mark>${match}</mark>`)
}

function escapeRegExp (string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function onResultsClicked (e) {
  if (e.target.classList.contains('result')) {
    const tabId = parseInt(e.target.dataset.id)

    if (!isModifierKeyPressed) {
      const searchQuery = document.getElementById('search').value

      await saveTextToHistory(searchQuery)

      try {
        await ch.sendMessageToTab(tabId, { context: 'highlight', searchQuery })
      } catch (error) {
        console.error('Error sending message to tab:', error)
      }

      await ch.tabsUpdate(tabId, { active: true })
      window.close()
    } else {
      await ch.tabsRemove(tabId)
      e.target.remove()
      navigation.selectNextOption()
    }
  } else if (e.target.classList.contains('search')) {
    const query = e.target.dataset.query
    await saveTextToHistory(query)
    await ch.chromeSearch({
      text: query,
      disposition: 'NEW_TAB'
    })
  } else if (e.target.classList.contains('history')) {
    const query = e.target.dataset.query
    updateSearchInputAndDispatchEvent(query)
  }
}

async function saveTextToHistory (text) {
  const MAX_HISTORY_ITEMS = 50

  const response = await ch.storageGet({ history: [] })
  response.history.unshift(text)

  if (response.history.length > MAX_HISTORY_ITEMS) {
    response.history = response.history.slice(0, MAX_HISTORY_ITEMS)
  }

  await ch.storageSet({ history: response.history })
}

async function onSearchKeydown (e) {
  if (e.shiftKey) {
    let newInputValue = null

    try {
      const response = await ch.storageGet({ history: [] })

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          if (currentHistoryIndex < response.history.length - 1) {
            currentHistoryIndex++
            newInputValue = response.history[currentHistoryIndex]
          }
          break
        case 'ArrowUp':
          e.preventDefault()
          if (currentHistoryIndex > 0) {
            currentHistoryIndex--
            newInputValue = response.history[currentHistoryIndex]
          }
          break
      }
    } catch (error) {
      console.error(error)
    }

    if (newInputValue) {
      updateSearchInputAndDispatchEvent(newInputValue)
    }
  }
}

function onDocumentKeydown (e) {
  if (e.key === 'Alt') {
    const resultsElements = document.querySelectorAll('.result')

    for (const el of resultsElements) {
      const rightLabelEl = el.querySelector('.right-detail-label')
      rightLabelEl.innerText = chrome.i18n.getMessage('SEARCH_RESULT_CLOSE_TAB')

      const rightIconEl = el.querySelector('.right-detail-icon')
      rightIconEl.classList.add('remove')
    }

    isModifierKeyPressed = true
  }
}

function onDocumentKeyup (e) {
  if (e.key === 'Alt') {
    const resultsElements = document.querySelectorAll('.result')

    for (const el of resultsElements) {
      const rightLabelEl = el.querySelector('.right-detail-label')
      rightLabelEl.innerText = chrome.i18n.getMessage('SEARCH_RESULT_GO_TO_TAB')

      const rightIconEl = el.querySelector('.right-detail-icon')
      rightIconEl.classList.remove('remove')
    }

    isModifierKeyPressed = false
  }
}

function updateSearchInputAndDispatchEvent (value) {
  const searchInput = document.getElementById('search')
  searchInput.value = value
  searchInput.select()

  const event = new Event('input', { bubbles: true })
  searchInput.dispatchEvent(event)
}
