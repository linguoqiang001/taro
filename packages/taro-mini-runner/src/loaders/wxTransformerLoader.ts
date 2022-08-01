import * as qs from 'querystring'
import * as path from 'path'

import { getOptions, stringifyRequest } from 'loader-utils'
import wxTransformer from '@tarojs/transformer-wx'
import { transform, transformFromAst } from 'babel-core'
import * as t from 'babel-types'
import generate from 'better-babel-generator'
import {
  REG_TYPESCRIPT,
  NODE_MODULES_REG,
  PARSE_AST_TYPE,
  isEmptyObject
} from '@tarojs/helper'

import processAst from '../utils/processAst'
import { npmCodeHack } from '../utils'
import parseAst from '../utils/parseAst'

const cannotRemoves = ['@tarojs/taro', 'react', 'nervjs']

const cachedResults = new Map()

export default function wxTransformerLoader(source) {
  const {
    babel: babelConfig,
    alias,
    buildAdapter,
    designWidth,
    deviceRatio,
    sourceDir,
    constantsReplaceList,
    nodeModulesPath,
    isBuildQuickapp,
    isUseComponentBuildPage
  } = getOptions(this)
  // 当前编译文件路径
  const filePath = this.resourcePath
  // ?后那部分
  const { resourceQuery } = this
  const rawQuery = resourceQuery.slice(1)
  const inheritQuery = `&${rawQuery}`
  // 分析如：a=1&b=2，获取参数对象
  const incomingQuery = qs.parse(rawQuery)
  try {
    const stringifyRequestFn = r => stringifyRequest(this, r)
    /**
     * 获取minitype，从incomingQuery、this._module、PARSE_AST_TYPE取
     * minType: {
     *  'app.tsx': 'ENTRY',
     *  'index/index.tsx': 'PAGE',
     *  '/node_modules/@tarojs/taro-weapp/index.js': 'NORMAL'
     * }
     */
    const miniType = (incomingQuery.parse ? incomingQuery.parse : this._module.miniType) || PARSE_AST_TYPE.NORMAL
    const rootProps: { [key: string]: any } = {}
    // 快应用相关，不看
    if (isBuildQuickapp && miniType === PARSE_AST_TYPE.PAGE) {
      // 如果是快应用，需要提前解析一次 ast，获取 config
      const aheadTransformResult = wxTransformer({
        code: source,
        sourcePath: filePath,
        sourceDir,
        isRoot: miniType === PARSE_AST_TYPE.PAGE,
        isTyped: REG_TYPESCRIPT.test(filePath),
        adapter: buildAdapter
      })
      const res = parseAst(aheadTransformResult.ast, filePath, nodeModulesPath, alias, isBuildQuickapp)
      const appConfig = this._compiler.appConfig
      if (res.configObj.enablePullDownRefresh || (appConfig.window && appConfig.window.enablePullDownRefresh)) {
        rootProps.enablePullDownRefresh = true
      }
      if (appConfig.tabBar) {
        rootProps.tabBar = appConfig.tabBar
      }
      rootProps.pagePath = filePath.replace(sourceDir, '').replace(path.extname(filePath), '')
      if (res.hasEnablePageScroll) {
        rootProps.enablePageScroll = true
      }
    }
    const wxTransformerParams: any = {
      code: source,
      sourceDir: sourceDir,
      sourcePath: filePath,
      isTyped: REG_TYPESCRIPT.test(filePath),
      adapter: buildAdapter,
      rootProps: isEmptyObject(rootProps) || rootProps,
      env: constantsReplaceList
    }
    if (miniType === PARSE_AST_TYPE.ENTRY) {
      wxTransformerParams.isApp = true
    } else if (miniType === PARSE_AST_TYPE.PAGE) {
      wxTransformerParams.isRoot = true
    } else if (miniType === PARSE_AST_TYPE.NORMAL) {
      wxTransformerParams.isNormal = true
    }
    let template, transCode
    if (!incomingQuery.parse) {
      // 经过wxTransformer，代码被转换成了小程序格式
      const transformResult = wxTransformer(wxTransformerParams)
      const ast = transformResult.ast
      // 转换后wxml内容
      template = transformResult.template
      // 加工ast
      const newAst = transformFromAst(ast, '', {
        plugins: [
          // 转换动态js内容
          [require('babel-plugin-preval')],
          // 移除无用import
          [require('babel-plugin-danger-remove-unused-import'), { ignore: cannotRemoves }],
          // 处理代码中的常量转换
          [require('babel-plugin-transform-define').default, constantsReplaceList]
        ]
      }).ast as t.File
      // 再次加工ast
      const result = processAst({
        ast: newAst,
        buildAdapter,
        type: miniType,
        designWidth,
        deviceRatio,
        sourceFilePath: filePath,
        sourceDir,
        alias,
        isBuildQuickapp,
        isUseComponentBuildPage
      })
      // 将ast转换为代码
      const code = generate(result).code
      // 在对code经过bable转换
      const res = transform(code, babelConfig)
      if (NODE_MODULES_REG.test(filePath) && res.code) {
        res.code = npmCodeHack(filePath, res.code)
      }
      // 转换后js代码
      transCode = res.code
      cachedResults.set(filePath, {
        template,
        transCode
      })
    } else {
      const cache = cachedResults.get(filePath)
      template = cache.template
      transCode = cache.transCode
    }

    let resultCode = ''
    if (miniType === PARSE_AST_TYPE.ENTRY || miniType === PARSE_AST_TYPE.PAGE || miniType === PARSE_AST_TYPE.COMPONENT) {
      if (incomingQuery.type === 'template') {
        return this.callback(null, template)
      }
      if (incomingQuery.type === 'script') {
        return this.callback(null, transCode)
      }
      if (template && template.length) {
        const query = `?taro&type=template&parse=${miniType}${inheritQuery}`
        const templateImport = `import { template } from ${stringifyRequestFn(filePath + query)};\n`
        resultCode += templateImport
      }
      const scriptQuery = `?taro&type=script&parse=${miniType}${inheritQuery}`
      const scriptRequest = stringifyRequestFn(filePath + scriptQuery)
      const scriptImport = (
        `import script from ${scriptRequest}\n` +
        `export * from ${scriptRequest}` // support named exports
      )
      resultCode += scriptImport
      return resultCode
    }
    return transCode
  } catch (error) {
    console.log(error)
    this.emitError(error)
    this.callback(null, source)
    return source
  }
}
