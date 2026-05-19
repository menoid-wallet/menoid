// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract ExecuteFunctionCallVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 1821104387914554201308003519859183764678369669715797314785847027359433162845;
    uint256 constant deltax2 = 3046836353006743662774357002999508136633159796999686627311728857579545917302;
    uint256 constant deltay1 = 14127546736926297596083442839832068899908155596324983149512017761050689204407;
    uint256 constant deltay2 = 6152546514224681551451399121728663628163055212505671608714674454902010091487;

    
    uint256 constant IC0x = 5621932379169423789038759880754006101949146888134657269812602572716344907756;
    uint256 constant IC0y = 3114951352645176532168882714382717350668699557224603427905352493269193075608;
    
    uint256 constant IC1x = 17940976922062441899575143024684315285117899901631665997836211646415847187942;
    uint256 constant IC1y = 21810635323043712657447877889230254348378844261247792683100278063342806375636;
    
    uint256 constant IC2x = 2762376831856594180161896788476610261162581546589735635348186194958056831204;
    uint256 constant IC2y = 5748436895995001744443291814423139176408979423078763670799982583769444320078;
    
    uint256 constant IC3x = 2205933015413340579233244956638640996258190331076008222600038086598040275429;
    uint256 constant IC3y = 3886864748748129332175392469202436500841081627867034314882967329802491065238;
    
    uint256 constant IC4x = 17478468453256873115463283655396161757561248088431460133135511822899946180727;
    uint256 constant IC4y = 19422072850202703735741247469375039537123364431393991168013241928005594862444;
    
    uint256 constant IC5x = 20674584235538540635044970075883610804455738010234268466551786564466556842494;
    uint256 constant IC5y = 7320932434217782108509486744028899271719150220939094236884234600356864137260;
    
    uint256 constant IC6x = 8166380537500632400652613676889693129154347868119823684584556692251469884050;
    uint256 constant IC6y = 5549425967153535687725104787786116338100788332482235524791945373928857491902;
    
    uint256 constant IC7x = 16361823468457259047589320247936251834140987112958873615069139595869078117998;
    uint256 constant IC7y = 14304750377121176030578834323555724538749855506465426089432977753709123841008;
    
    uint256 constant IC8x = 926618345366579552353382452849483213591960932988657715403719476706678434884;
    uint256 constant IC8y = 4806260790049619255946402794290311251799651980127443531665078431244535985647;
    
    uint256 constant IC9x = 2281352279576413967603383867921889893410497914097829284073973596655329900164;
    uint256 constant IC9y = 17583908883143285085326952021249964787778213033951823813572643430152241805149;
    
    uint256 constant IC10x = 17167658421592973396493211681852669451435343783115662339890143522448610982128;
    uint256 constant IC10y = 1119032828997380962211574944599307704297061486299325632150323047425723396431;
    
    uint256 constant IC11x = 16283776067397191926523454128202805085106654569407386028370015699570085569512;
    uint256 constant IC11y = 2951635218395307185258350410115824898549603480437959134342515372135191172309;
    
    uint256 constant IC12x = 19311282815630236928486434685489702134179334305507061904704748402755397349543;
    uint256 constant IC12y = 18411856809212724388813474421613913472713945578783410858734198082593532906518;
    
    uint256 constant IC13x = 16951036885549693579209128851936716033921434699417755750976275714599276077901;
    uint256 constant IC13y = 6071216802962228783531945809603711209839077736710094036907125494509626492071;
    
    uint256 constant IC14x = 12767359597842531644238271445414665681958283744430551161143967328441888134393;
    uint256 constant IC14y = 18304585214226067194466865564412169626309096384350396657911293909993732846585;
    
    uint256 constant IC15x = 1165248273904409485699036280869872328221061866413281956760046962038489899802;
    uint256 constant IC15y = 8175834834845281486318916113521718242425230063181821051178898100485077238912;
    
    uint256 constant IC16x = 5078273036476695048861320350489160446270187872239928653791714414820872527897;
    uint256 constant IC16y = 192950396307463770228168779943282114119289625039632217296555115484028510858;
    
    uint256 constant IC17x = 14565592381699430900430153931436108612599804325430162737348494113454132828976;
    uint256 constant IC17y = 12223365529840474904967623356098161605881163654738713478324254256058795025845;
    
    uint256 constant IC18x = 17541305435333869434821288618342502947362965804669824278773116240970646157288;
    uint256 constant IC18y = 4898693052502416144372062855769058724315312078701201022866527327561904417939;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[18] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
