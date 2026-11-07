import { describe, expect, it } from 'vitest'
import { modelCommandArgument, resolveModelCommand, sessionModelPatch } from './model-command'

describe('model commands', () => {
  it.each(['/models Opus', '/modeling', '/model/file', '/tmp/file', 'Explain /model Opus', '`/model Opus`'])('preserves ordinary text: %s', text => {
    expect(modelCommandArgument(text)).toBeNull()
  })
  it('parses bare commands and arguments without prompt rewriting', () => {
    expect(modelCommandArgument(' /model ')).toBe('')
    expect(modelCommandArgument('/MODEL Opus')).toBe('Opus')
    expect(modelCommandArgument('/model Opus\nextra text')).toBe('Opus\nextra text')
  })
  it('uses exact IDs, unique labels and default; rejects locked, ambiguous and multiline arguments', () => {
    const options = [{value:'', label:'Server default'}, {value:'opus',label:'Opus'},
      {value:'fast-a',label:'Fast'}, {value:'fast-b',label:'Fast'}, {value:'locked',label:'Locked',locked:true}]
    expect(resolveModelCommand('Opus', options)?.value).toBe('opus')
    expect(resolveModelCommand('default', options)?.value).toBe('')
    for (const argument of ['op', 'Fast', 'locked', 'Opus\nextra', 'unknown']) expect(resolveModelCommand(argument, options)).toBeUndefined()
    expect(resolveModelCommand('Friendly name', [{value:'vendor/model',label:'Friendly name'}])?.value).toBe('vendor/model')
  })
  it('shares model/effort normalization with the picker', () => {
    expect(sessionModelPatch({id:'qa', title:'QA', backend:'codex',effort:'high'}, {backends:{codex:{models:[],efforts:[],model_efforts:{small:[{value:'low',label:'Low'}]}}}}, 'small')).toEqual({model:'small',effort:'low'})
    expect(sessionModelPatch({id:'qa',title:'QA',backend:'cursor',effort:'high'}, null, '')).toEqual({model:null,effort:null})
  })
})
