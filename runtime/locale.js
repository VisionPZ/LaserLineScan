// SPDX-License-Identifier: GPL-3.0-or-later

// Human-readable values follow the selected site language. Machine exports
// (JSON, PLY and numerical model coefficients) keep their portable notation.
const regionalLocales={en:'en-GB',zh:'zh-Hans-CN',no:'nb-NO',de:'de-DE',fr:'fr-FR',es:'es-ES',nl:'nl-NL',sv:'sv-SE',da:'da-DK',pt:'pt-PT',it:'it-IT',ja:'ja-JP'};
export function localeFormats(language='en'){
 const locale=regionalLocales[language]||'en-GB',cache=new Map();
 const format=(value,style,digits)=>{
  const key=style+digits;
  if(!cache.has(key))cache.set(key,new Intl.NumberFormat(locale,{style,minimumFractionDigits:digits,maximumFractionDigits:digits}));
  return cache.get(key).format(value);
 };
 return {locale,number:(value,digits=0)=>format(value,'decimal',digits),percent:(value,digits=1)=>format(value,'percent',digits)};
}
